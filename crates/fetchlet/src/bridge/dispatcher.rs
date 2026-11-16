use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::clock::Clock;
use crate::config::check_limit;
use crate::execution::WakeSignal;
use crate::host::{Redirect, TransportFuture};
use crate::wire::{WireRequest, WireResponse};
use crate::{Error, HostServices, Limits, Response, Result};

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
use super::crypto;

struct PendingFetch {
    future: TransportFuture,
}

struct InvocationState {
    generation: u64,
    next_ticket: u64,
    started_fetches: usize,
    limits: Limits,
    pending_fetches: BTreeMap<String, PendingFetch>,
}

#[derive(Default)]
struct BridgeState {
    generation: u64,
    invocation: Option<InvocationState>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FetchStartRequest {
    request: WireRequest,
    #[serde(default)]
    redirect: Redirect,
    service: Option<String>,
}

#[derive(Serialize)]
struct FetchCompletion {
    id: String,
    result: Value,
}

/// Native callbacks retain this handle rather than request-scoped JS globals.
#[derive(Clone)]
pub(crate) struct HostBridge {
    services: HostServices,
    state: Arc<Mutex<BridgeState>>,
    limits: Limits,
    wake: WakeSignal,
    clock: Clock,
}

impl Default for HostBridge {
    fn default() -> Self {
        Self::new(HostServices::default())
    }
}

impl HostBridge {
    pub fn new(services: HostServices) -> Self {
        Self::with_limits(services, Limits::default())
    }

    pub fn with_limits(services: HostServices, limits: Limits) -> Self {
        Self {
            services,
            state: Arc::new(Mutex::new(BridgeState::default())),
            limits,
            wake: WakeSignal::default(),
            clock: Clock::default(),
        }
    }

    pub fn wake_signal(&self) -> WakeSignal {
        self.wake.clone()
    }

    fn effective_limits(&self) -> Result<Limits> {
        let state = self.lock_state()?;
        Ok(state
            .invocation
            .as_ref()
            .map(|invocation| invocation.limits.clone())
            .unwrap_or_else(|| self.limits.clone()))
    }

    pub fn begin(&self, limits: Limits) -> Result<InvocationScope> {
        let mut state = self.lock_state()?;
        if state.invocation.is_some() {
            return Err(Error::InstanceUnavailable);
        }

        state.generation = state
            .generation
            .checked_add(1)
            .ok_or(Error::LimitExceeded("invocation IDs"))?;

        let generation = state.generation;
        state.invocation = Some(InvocationState {
            generation,
            next_ticket: 0,
            started_fetches: 0,
            limits,
            pending_fetches: BTreeMap::new(),
        });

        Ok(InvocationScope {
            bridge: self.clone(),
            generation,
        })
    }

    pub fn dispatch(&self, operation: String, input: String) -> String {
        encode_reply(self.dispatch_operation(&operation, &input)).to_string()
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, BridgeState>> {
        self.state.lock().map_err(|_| Error::InstanceUnavailable)
    }

    pub(super) fn dispatch_operation(&self, operation: &str, input: &str) -> Result<Value> {
        let limits = self.effective_limits()?;
        check_limit(
            limits.bridge_message_bytes,
            input.len(),
            "bridge message bytes",
        )?;

        match operation {
            "bindings" => Ok(self.bindings()),
            "clock" => Ok(self.clock.read()),
            "invocation.limits" => self.invocation_limits(),
            "fetch.start" => self.start_fetch(input),
            "fetch.poll" => self.poll_fetches(),
            "fetch.cancel" => self.cancel_fetch(input),
            #[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
            "random" | "sha256" => crypto::dispatch(operation, input, &limits),
            _ => Err(Error::PermissionDenied),
        }
    }

    fn bindings(&self) -> Value {
        let service_names: Vec<_> = self.services.services.keys().collect();

        json!({
            "env": self.services.env,
            "services": service_names,
        })
    }

    fn invocation_limits(&self) -> Result<Value> {
        let state = self.lock_state()?;
        let invocation = state.invocation.as_ref().ok_or(Error::InvocationClosed)?;
        Ok(json!({
            "requestBodyBytes": invocation.limits.request_body_bytes.map(|value| value.to_string()),
            "requestBodyChunks": invocation.limits.request_body_chunks.map(|value| value.to_string()),
        }))
    }

    pub(super) fn start_fetch(&self, input: &str) -> Result<Value> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;

        let started = invocation
            .started_fetches
            .checked_add(1)
            .ok_or(Error::LimitExceeded("subrequest counter"))?;
        check_limit(invocation.limits.subrequests, started, "subrequests")?;
        invocation.started_fetches = started;

        let start: FetchStartRequest = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid fetch message".into()))?;
        let service = match start.service {
            Some(name) => self.services.services.get(&name),
            None => self.services.outbound.as_ref(),
        }
        .cloned()
        .ok_or(Error::PermissionDenied)?;

        let request = start.request.into_http(&invocation.limits)?;
        let limits = invocation.limits.clone();
        let future =
            Box::pin(async move { service.execute(request, start.redirect, limits).await });

        invocation.next_ticket = invocation
            .next_ticket
            .checked_add(1)
            .ok_or(Error::LimitExceeded("fetch tickets"))?;

        let ticket = format!("{}:{}", invocation.generation, invocation.next_ticket);
        invocation
            .pending_fetches
            .insert(ticket.clone(), PendingFetch { future });

        Ok(Value::String(ticket))
    }

    pub(super) fn poll_fetches(&self) -> Result<Value> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;

        // Engines pump host futures between microtasks and yield between pumps.
        // The futures stay in this scope; no detached tasks need to be aborted.
        let waker = self.wake.waker();
        let mut context = Context::from_waker(&waker);
        let mut completed = Vec::new();

        for (ticket, pending) in &mut invocation.pending_fetches {
            let Poll::Ready(response) = pending.future.as_mut().poll(&mut context) else {
                continue;
            };

            let result =
                response.and_then(|response| encode_response(response, &invocation.limits));

            completed.push(FetchCompletion {
                id: ticket.clone(),
                result: encode_reply(result),
            });
        }

        for completion in &completed {
            invocation.pending_fetches.remove(&completion.id);
        }

        serde_json::to_value(completed)
            .map_err(|_| Error::Transport("invalid completion encoding".into()))
    }

    pub(super) fn cancel_fetch(&self, input: &str) -> Result<Value> {
        let ticket: String = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid fetch ticket".into()))?;

        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;

        if invocation.pending_fetches.remove(&ticket).is_none() {
            return Err(Error::InvocationClosed);
        }

        Ok(Value::Null)
    }
}

pub(crate) struct InvocationScope {
    bridge: HostBridge,
    generation: u64,
}

impl InvocationScope {
    pub fn has_pending(&self) -> bool {
        let Ok(state) = self.bridge.lock_state() else {
            return true;
        };

        state.invocation.as_ref().is_some_and(|invocation| {
            invocation.generation == self.generation && !invocation.pending_fetches.is_empty()
        })
    }
}

impl Drop for InvocationScope {
    fn drop(&mut self) {
        // Cleanup must still run after a panicking trusted transport poisoned
        // the lock. Further operations fail closed through lock_state().
        let mut state = self
            .bridge
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let owns_invocation = state
            .invocation
            .as_ref()
            .is_some_and(|invocation| invocation.generation == self.generation);

        if owns_invocation {
            state.invocation = None;
        }
    }
}

fn encode_response(response: Response, limits: &Limits) -> Result<Value> {
    let response = WireResponse::from_http(response, limits)?;
    serde_json::to_value(response).map_err(|_| Error::Transport("invalid response encoding".into()))
}

fn encode_reply(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({
            "ok": true,
            "value": value,
        }),
        Err(error) => json!({
            "ok": false,
            "error": {
                "code": error.code(),
                "message": error.guest_message(),
            },
        }),
    }
}

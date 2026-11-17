use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::Poll;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::body_source::{BodyRead, BodySources};
use super::clock::Clock;
use crate::config::check_limit;
use crate::execution::WakeSignal;
use crate::host::{Redirect, TransportFuture};
use crate::reentry;
use crate::wire::{BodyTransfer, ByteStore, ByteTransport, WireBytes, WireRequest, WireResponse};
use crate::{Body, ConsoleLevel, Context, Error, HostServices, Limits, Response, Result};

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
use super::crypto;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing"
))]
use super::url_api;

struct PendingFetch {
    future: TransportFuture,
}

struct InvocationState {
    generation: u64,
    next_ticket: u64,
    started_fetches: usize,
    limits: Limits,
    pending_fetches: BTreeMap<String, PendingFetch>,
    bytes: ByteStore,
    /// Rust bodies that JavaScript reads on demand.
    bodies: BodySources,
    /// Outstanding `body.read` tickets and the body each one reads.
    pending_reads: BTreeMap<String, u64>,
    /// `fetchlet.waitUntil` registrations, and those not yet settled.
    background_registered: usize,
    background_pending: usize,
    /// Trusted values attached to each host fetch of this invocation.
    context: Option<Context>,
}

impl InvocationState {
    fn next_ticket(&mut self) -> Result<String> {
        self.next_ticket = self
            .next_ticket
            .checked_add(1)
            .ok_or(Error::LimitExceeded("host operation tickets"))?;
        Ok(format!("{}:{}", self.generation, self.next_ticket))
    }

    fn transport(&mut self) -> InvocationTransport<'_> {
        InvocationTransport {
            bytes: &mut self.bytes,
            bodies: &mut self.bodies,
        }
    }
}

/// Byte transport within the locked state of an invocation.
struct InvocationTransport<'a> {
    bytes: &'a mut ByteStore,
    bodies: &'a mut BodySources,
}

impl ByteTransport for InvocationTransport<'_> {
    fn send(&mut self, bytes: Bytes) -> Result<WireBytes> {
        self.bytes.put(bytes).map(WireBytes::Handle)
    }

    fn receive(&mut self, bytes: WireBytes) -> Result<Bytes> {
        match bytes {
            WireBytes::Handle(handle) => self.bytes.take(handle),
            WireBytes::Inline(bytes) => Ok(bytes.into()),
        }
    }

    fn stream(
        &mut self,
        body: Body,
        limit: Option<usize>,
        resource: &'static str,
    ) -> Result<BodyTransfer> {
        if body.is_buffered() {
            return Ok(BodyTransfer::Collect(body));
        }
        // A declared length over the budget fails before JavaScript reads it.
        check_limit(limit, body.declared_len(), resource)?;
        self.bodies
            .open(body, limit, resource)
            .map(BodyTransfer::Stream)
    }
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
    /// The application identity used to refuse reentrant calls.
    key: u64,
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
            key: reentry::new_key(),
        }
    }

    /// Use the identity of an application whose worker recreates instances.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn with_key(mut self, key: u64) -> Self {
        self.key = key;
        self
    }

    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
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

    #[cfg(any(feature = "fuzzing", test))]
    pub fn begin(&self, limits: Limits) -> Result<InvocationScope> {
        self.begin_with_context(limits, None)
    }

    pub fn begin_with_context(
        &self,
        limits: Limits,
        context: Option<Context>,
    ) -> Result<InvocationScope> {
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
            bytes: ByteStore::default(),
            bodies: BodySources::default(),
            pending_reads: BTreeMap::new(),
            background_registered: 0,
            background_pending: 0,
            context,
        });

        Ok(InvocationScope {
            bridge: self.clone(),
            generation,
        })
    }

    pub fn dispatch(&self, operation: String, input: String) -> String {
        encode_reply(self.dispatch_operation(&operation, &input)).to_string()
    }

    /// Copy bytes from a JavaScript typed array into the current invocation.
    ///
    /// Each buffer is one bridge message from the guest, so
    /// `bridge_message_bytes` applies to it, as to JSON messages.
    pub fn put_guest_bytes(&self, bytes: &[u8]) -> Result<u64> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        check_limit(
            invocation.limits.bridge_message_bytes,
            bytes.len(),
            "bridge message bytes",
        )?;
        invocation.bytes.put_guest(Bytes::copy_from_slice(bytes))
    }

    /// Take bytes by a handle that a JavaScript number carried.
    pub fn take_guest_bytes(&self, handle: f64) -> Result<Bytes> {
        // Handles are positive integers below 2^53, exact in a JS number.
        if !((1.0..=9_007_199_254_740_991.0).contains(&handle) && handle.fract() == 0.0) {
            return Err(Error::InvalidRequest("invalid byte handle".into()));
        }
        self.take_bytes(handle as u64)
    }

    /// Take bytes that the other side of the current invocation stored.
    pub fn take_bytes(&self, handle: u64) -> Result<Bytes> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        invocation.bytes.take(handle)
    }

    /// Let JavaScript in the current invocation read `body` on demand.
    #[cfg(any(test, feature = "fuzzing"))]
    pub fn open_body(
        &self,
        body: Body,
        limit: Option<usize>,
        resource: &'static str,
    ) -> Result<u64> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        invocation.bodies.open(body, limit, resource)
    }

    fn with_transport<T>(
        &self,
        operation: impl FnOnce(&mut InvocationTransport<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        operation(&mut invocation.transport())
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
            "body.read" => self.read_body(input),
            "body.cancel" => self.cancel_body(input),
            "background.register" => self.register_background(),
            "background.settle" => self.settle_background(),
            "console.write" => self.write_console(input),
            #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
            "random" | "sha256" => crypto::dispatch(operation, input, &limits),
            #[cfg(any(
                feature = "boa",
                feature = "quickjs",
                feature = "v8",
                feature = "fuzzing"
            ))]
            "url.parse" | "url.set" => url_api::dispatch(operation, input),
            _ => Err(Error::PermissionDenied),
        }
    }

    fn bindings(&self) -> Value {
        let service_names: Vec<_> = self.services.services.keys().collect();

        json!({
            "env": self.services.env,
            "services": service_names,
            "console": self.services.console.is_some(),
        })
    }

    fn write_console(&self, input: &str) -> Result<Value> {
        #[derive(Deserialize)]
        struct Message<'a> {
            level: &'a str,
            #[serde(borrow)]
            message: std::borrow::Cow<'a, str>,
        }
        let sink = self
            .services
            .console
            .as_ref()
            .ok_or(Error::PermissionDenied)?;
        let message: Message<'_> = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid console message".into()))?;
        let level = ConsoleLevel::parse(message.level)
            .ok_or_else(|| Error::InvalidRequest("unknown console level".into()))?;
        sink.write(level, &message.message);
        Ok(Value::Null)
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

        let mut request = start
            .request
            .into_http(&invocation.limits, &mut invocation.bytes)?;
        if let Some(context) = &invocation.context {
            request.extensions_mut().insert(context.clone());
        }
        let limits = invocation.limits.clone();
        let future =
            Box::pin(async move { service.execute(request, start.redirect, limits).await });

        let ticket = invocation.next_ticket()?;
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
        let mut context = std::task::Context::from_waker(&waker);
        let mut completed = Vec::new();
        // Host code polled here must not call this application again.
        let _polling = reentry::enter(self.key);

        let InvocationState {
            pending_fetches,
            limits,
            bytes,
            bodies,
            pending_reads,
            ..
        } = invocation;
        let mut transport = InvocationTransport { bytes, bodies };

        for (ticket, pending) in pending_fetches.iter_mut() {
            let Poll::Ready(response) = pending.future.as_mut().poll(&mut context) else {
                continue;
            };

            let result =
                response.and_then(|response| encode_response(response, limits, &mut transport));

            completed.push(FetchCompletion {
                id: ticket.clone(),
                result: encode_reply(result),
            });
        }

        for completion in &completed {
            pending_fetches.remove(&completion.id);
        }

        let InvocationTransport { bytes, bodies } = transport;
        pending_reads.retain(|ticket, id| {
            let result = match bodies.get_mut(*id) {
                Some(source) => match source.poll_read(&mut context) {
                    Poll::Pending => return true,
                    Poll::Ready(Ok(BodyRead::Chunk(chunk))) => bytes
                        .put(chunk)
                        .map(|handle| json!({ "chunk": handle, "done": false })),
                    Poll::Ready(Ok(BodyRead::Done)) => Ok(json!({ "chunk": null, "done": true })),
                    Poll::Ready(Err(error)) => Err(error),
                },
                None => Err(Error::InvocationClosed),
            };
            // A finished or failed body releases its producer now.
            if !matches!(result, Ok(ref value) if value["done"] == false) {
                bodies.remove(*id);
            }
            completed.push(FetchCompletion {
                id: ticket.clone(),
                result: encode_reply(result),
            });
            false
        });

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

    pub(super) fn register_background(&self) -> Result<Value> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        let registered = invocation
            .background_registered
            .checked_add(1)
            .ok_or(Error::LimitExceeded("background tasks"))?;
        check_limit(
            invocation.limits.background_tasks,
            registered,
            "background tasks",
        )?;
        invocation.background_registered = registered;
        invocation.background_pending += 1;
        Ok(Value::Null)
    }

    pub(super) fn settle_background(&self) -> Result<Value> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        invocation.background_pending = invocation.background_pending.saturating_sub(1);
        Ok(Value::Null)
    }

    pub(super) fn read_body(&self, input: &str) -> Result<Value> {
        let id: u64 = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid body id".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        if !invocation.bodies.contains(id) {
            return Err(Error::InvalidRequest("unknown body".into()));
        }
        // One read at a time, as a ReadableStream pulls.
        if invocation
            .pending_reads
            .values()
            .any(|reading| *reading == id)
        {
            return Err(Error::InvalidRequest("body is already being read".into()));
        }
        let ticket = invocation.next_ticket()?;
        invocation.pending_reads.insert(ticket.clone(), id);
        Ok(Value::String(ticket))
    }

    pub(super) fn cancel_body(&self, input: &str) -> Result<Value> {
        let id: u64 = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid body id".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        // Dropping the body cancels its producer. Cancelling twice is harmless.
        invocation.bodies.remove(id);
        invocation.pending_reads.retain(|_, reading| *reading != id);
        Ok(Value::Null)
    }
}

pub(crate) struct InvocationScope {
    bridge: HostBridge,
    generation: u64,
}

impl InvocationScope {
    /// Whether `fetchlet.waitUntil` work of this invocation has not settled.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn has_background(&self) -> bool {
        let Ok(state) = self.bridge.lock_state() else {
            return false;
        };

        state.invocation.as_ref().is_some_and(|invocation| {
            invocation.generation == self.generation && invocation.background_pending > 0
        })
    }

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

fn encode_response(
    response: Response,
    limits: &Limits,
    bytes: &mut impl ByteTransport,
) -> Result<Value> {
    let response = WireResponse::from_http(response, limits, bytes)?;
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

/// Byte transport through the current invocation of a bridge.
impl ByteTransport for HostBridge {
    fn send(&mut self, bytes: Bytes) -> Result<WireBytes> {
        self.with_transport(|transport| transport.send(bytes))
    }

    fn receive(&mut self, bytes: WireBytes) -> Result<Bytes> {
        self.with_transport(|transport| transport.receive(bytes))
    }

    fn stream(
        &mut self,
        body: Body,
        limit: Option<usize>,
        resource: &'static str,
    ) -> Result<BodyTransfer> {
        self.with_transport(|transport| transport.stream(body, limit, resource))
    }
}

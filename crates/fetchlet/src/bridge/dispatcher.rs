use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::Poll;

use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Value, json};

use super::body_source::{BodyRead, BodySource};
use super::channels::{GuestClose, GuestMessage, GuestPause, GuestWrite};
use super::clock::Clock;
use super::handles::{Handles, Resource};
use crate::config::check_limit;
use crate::execution::WakeSignal;
use crate::host::{Redirect, TransportFuture, pair};
use crate::reentry;
use crate::wire::{BodyTransfer, ByteStore, ByteTransport, WireBytes, WireRequest, WireResponse};
use crate::{
    Body, ChannelEnd, ChannelRequest, CloseFrame, ConsoleLevel, Context, Error, HostServices,
    Limits, Response, Result,
};

struct PendingFetch {
    future: TransportFuture,
}

/// A read of a body source, of its next chunk or of all the rest.
struct PendingRead {
    id: u64,
    whole: Option<Whole>,
}

/// How a whole-body read hands the body to JavaScript.
#[derive(Clone, Copy)]
pub(super) enum Whole {
    /// One buffer in the byte store.
    Bytes,
    /// A string, decoded as Fetch's `text()` decodes: UTF-8 without a
    /// leading byte order mark, with U+FFFD for invalid sequences.
    Text,
}

struct InvocationState {
    generation: u64,
    next_ticket: u64,
    started_fetches: usize,
    /// `channel.open` attempts, which `Limits::open_channels` bounds.
    opened_channels: usize,
    limits: Limits,
    pending_fetches: BTreeMap<String, PendingFetch>,
    bytes: ByteStore,
    /// What JavaScript reaches by handle: Rust bodies it reads on demand and
    /// channels it holds, such as an accepted WebSocket.
    handles: Handles,
    /// Outstanding `body.read` and `body.readAll` tickets.
    pending_reads: BTreeMap<String, PendingRead>,
    /// `fetchlet.waitUntil` registrations, and those not yet settled.
    background_registered: usize,
    background_pending: usize,
    /// Trusted values attached to each host fetch of this invocation.
    context: Option<Context>,
    /// Set when the client of this Fetch invocation went away; JavaScript
    /// aborts the request's signal when it sees it.
    disconnect: Option<Disconnect>,
    /// Web API state, such as open compression streams.
    #[cfg(feature = "web")]
    web: fetchlet_web::WebState,
    /// Whether this Fetch invocation may accept a WebSocket upgrade.
    upgrade: Upgrade,
}

/// The WebSocket upgrade of a Fetch invocation.
enum Upgrade {
    /// The request did not ask for one, or the host cannot hold it.
    Unavailable,
    Available,
    /// JavaScript accepted it; Rust's end waits for the response.
    Accepted {
        id: u64,
        end: Option<ChannelEnd>,
    },
}

/// Tells a running Fetch invocation that its client went away.
///
/// The worker signals it while it lets a cancelled call finish
/// ([`CancelledCalls::Finish`](crate::CancelledCalls::Finish)); the engine
/// wakes, and JavaScript aborts the request's signal at its next host step.
#[derive(Clone)]
pub(crate) struct Disconnect {
    gone: Arc<AtomicBool>,
    wake: WakeSignal,
}

impl Disconnect {
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn signal(&self) {
        self.gone.store(true, Ordering::Release);
        self.wake.notify();
    }

    fn is_signalled(&self) -> bool {
        self.gone.load(Ordering::Acquire)
    }
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
            handles: &mut self.handles,
        }
    }
}

/// Byte transport within the locked state of an invocation.
struct InvocationTransport<'a> {
    bytes: &'a mut ByteStore,
    handles: &'a mut Handles,
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
        self.handles
            .insert(Resource::Body(BodySource::new(body, limit, resource)))
            .map(BodyTransfer::Stream)
    }
}

#[derive(Default)]
struct BridgeState {
    generation: u64,
    invocation: Option<InvocationState>,
    /// The handle table between invocations, every entry released. Its
    /// generations carry over, so an earlier invocation's handles stay stale.
    handles: Handles,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FetchStartRequest {
    request: WireRequest,
    #[serde(default)]
    redirect: Redirect,
    service: Option<String>,
}

struct FetchCompletion {
    id: String,
    result: Value,
}

impl FetchCompletion {
    /// Moves the result into the message; a whole body read as text can be
    /// megabytes long.
    fn into_value(self) -> Value {
        json!({ "id": self.id, "result": self.result })
    }
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
    /// The runtime whose context host futures are polled in, if not the
    /// instance's own ([`AppBuilder::host_runtime`](crate::AppBuilder::host_runtime)).
    runtime: Option<tokio::runtime::Handle>,
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
            runtime: None,
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

    /// Poll host futures in the context of `runtime`.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn with_runtime(mut self, runtime: tokio::runtime::Handle) -> Self {
        self.runtime = Some(runtime);
        self
    }

    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn wake_signal(&self) -> WakeSignal {
        self.wake.clone()
    }

    /// A new disconnect token for a Fetch invocation of this bridge.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn disconnect(&self) -> Disconnect {
        Disconnect {
            gone: Arc::default(),
            wake: self.wake.clone(),
        }
    }

    /// Attach `disconnect` to the current invocation.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn watch_disconnect(&self, disconnect: Disconnect) -> Result<()> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        invocation.disconnect = Some(disconnect);
        Ok(())
    }

    /// Let the current Fetch invocation accept a WebSocket upgrade.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn allow_upgrade(&self) -> Result<()> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        // An upgrade already accepted stays accepted.
        if matches!(invocation.upgrade, Upgrade::Unavailable) {
            invocation.upgrade = Upgrade::Available;
        }
        Ok(())
    }

    /// Rust's end of the upgrade that the Fetch result returned as `id`.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn take_upgrade(&self, id: u64) -> Result<ChannelEnd> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        match &mut invocation.upgrade {
            Upgrade::Accepted { id: accepted, end } if *accepted == id => end
                .take()
                .ok_or_else(|| Error::InvalidRequest("upgrade already returned".into())),
            _ => Err(Error::InvalidRequest("unknown upgrade".into())),
        }
    }

    /// Close the current invocation's channels on the host's behalf.
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub fn close_channels(&self, frame: &CloseFrame) {
        if let Ok(mut state) = self.lock_state()
            && let Some(invocation) = state.invocation.as_mut()
        {
            invocation.handles.force_channels(frame);
        }
        self.wake.notify();
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
        let handles = std::mem::take(&mut state.handles);
        state.invocation = Some(InvocationState {
            generation,
            next_ticket: 0,
            started_fetches: 0,
            opened_channels: 0,
            limits,
            pending_fetches: BTreeMap::new(),
            bytes: ByteStore::default(),
            handles,
            pending_reads: BTreeMap::new(),
            background_registered: 0,
            background_pending: 0,
            context,
            disconnect: None,
            #[cfg(feature = "web")]
            web: fetchlet_web::WebState::default(),
            upgrade: Upgrade::Unavailable,
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
        invocation
            .handles
            .insert(Resource::Body(BodySource::new(body, limit, resource)))
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

        #[cfg(feature = "web")]
        if let Some(result) = self.web_operation(operation, input) {
            return result;
        }

        match operation {
            "background.register" => self.register_background(),
            "background.settle" => self.settle_background(),
            "bindings" => Ok(self.bindings()),
            "body.cancel" => self.cancel_body(input),
            "body.read" => self.read_body(input, None),
            "body.readAll" => self.read_body(input, Some(Whole::Bytes)),
            "body.readText" => self.read_body(input, Some(Whole::Text)),
            "channel.buffered" => self.channel_buffered(input),
            "channel.close" => self.close_channel(input),
            "channel.open" => self.open_channel(input),
            "channel.pause" => self.pause_channel(input),
            "channel.send" => self.send_channel(input),
            "channel.write" => self.write_channel(input),
            "clock" => Ok(self.clock.read()),
            "console.write" => self.write_console(input),
            "fetch.cancel" => self.cancel_fetch(input),
            "fetch.poll" => self.poll_fetches(),
            "fetch.start" => self.start_fetch(input),
            "invocation.disconnected" => self.invocation_disconnected(),
            "invocation.limits" => self.invocation_limits(),
            "websocket.upgrade" => self.upgrade_websocket(),
            _ => Err(Error::PermissionDenied),
        }
    }

    /// A Web API operation of `fetchlet-web`, with the current invocation's
    /// state and byte store when one is active, or None for other operations.
    #[cfg(feature = "web")]
    fn web_operation(&self, operation: &str, input: &str) -> Option<Result<Value>> {
        let mut state = match self.lock_state() {
            Ok(state) => state,
            Err(error) => return Some(Err(error)),
        };
        match state.invocation.as_mut() {
            Some(invocation) => {
                let limits = invocation.limits.web();
                fetchlet_web::dispatch(
                    operation,
                    input,
                    &limits,
                    Some(fetchlet_web::Invocation {
                        state: &mut invocation.web,
                        bytes: &mut WebBytes(&mut invocation.bytes),
                    }),
                )
            }
            None => {
                fetchlet_web::dispatch::<WebBytes<'_>>(operation, input, &self.limits.web(), None)
            }
        }
    }

    fn bindings(&self) -> Value {
        let service_names: Vec<_> = self.services.services.keys().collect();
        let channel_names: Vec<_> = self.services.channels.keys().collect();

        json!({
            "env": self.services.env,
            "services": service_names,
            "channels": channel_names,
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

    /// Whether the client of the current invocation went away. Outside a
    /// Fetch invocation, or between invocations, it has not.
    fn invocation_disconnected(&self) -> Result<Value> {
        let state = self.lock_state()?;
        Ok(Value::Bool(state.invocation.as_ref().is_some_and(
            |invocation| {
                invocation
                    .disconnect
                    .as_ref()
                    .is_some_and(Disconnect::is_signalled)
            },
        )))
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
        // Tasks, timers and I/O that host futures create belong to the host
        // runtime, so they progress while this instance runs JavaScript.
        let _runtime = self.runtime.as_ref().map(tokio::runtime::Handle::enter);

        let InvocationState {
            pending_fetches,
            limits,
            bytes,
            handles,
            pending_reads,
            ..
        } = invocation;
        let mut transport = InvocationTransport { bytes, handles };

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

        let InvocationTransport { bytes, handles } = transport;
        pending_reads.retain(|ticket, read| {
            let id = read.id;
            let result = match handles.body_mut(id) {
                Some(source) if let Some(whole) = read.whole => {
                    match source.poll_read_all(&mut context) {
                        Poll::Pending => return true,
                        Poll::Ready(Ok(body)) => match whole {
                            Whole::Bytes => bytes
                                .put(body)
                                .map(|handle| json!({ "chunk": handle, "done": true })),
                            Whole::Text => Ok(json!({ "text": utf8_decode(&body), "done": true })),
                        },
                        Poll::Ready(Err(error)) => Err(error),
                    }
                }
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
                handles.release_body(id);
            }
            completed.push(FetchCompletion {
                id: ticket.clone(),
                result: encode_reply(result),
            });
            false
        });

        let mut events: Vec<Value> = completed
            .into_iter()
            .map(FetchCompletion::into_value)
            .collect();
        // Messages and closes of channels, each channel's in order.
        if handles.has_channels() {
            handles.poll_channels(&mut context, bytes, &mut events)?;
        }
        Ok(Value::Array(events))
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

    /// Accept the WebSocket upgrade of the current Fetch invocation.
    fn upgrade_websocket(&self) -> Result<Value> {
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        match invocation.upgrade {
            Upgrade::Available => {}
            Upgrade::Accepted { .. } => {
                return Err(Error::InvalidRequest(
                    "the request is already upgraded".into(),
                ));
            }
            Upgrade::Unavailable => return Err(Error::PermissionDenied),
        }
        let (end, guest) = pair(&invocation.limits);
        let id = invocation
            .handles
            .open_connection(guest, &invocation.limits)?;
        invocation.upgrade = Upgrade::Accepted { id, end: Some(end) };
        Ok(Value::from(id))
    }

    /// Open a channel of a bound service for the current invocation. The
    /// handle is JavaScript's at once; the open settles in the host pump.
    fn open_channel(&self, input: &str) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Open {
            service: String,
            #[serde(default)]
            options: Value,
        }
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        let opened = invocation
            .opened_channels
            .checked_add(1)
            .ok_or(Error::LimitExceeded("channel counter"))?;
        check_limit(invocation.limits.open_channels, opened, "open channels")?;
        invocation.opened_channels = opened;

        let open: Open = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid channel open".into()))?;
        let service = self
            .services
            .channels
            .get(&open.service)
            .ok_or(Error::PermissionDenied)?;
        let (end, guest) = pair(&invocation.limits);
        let request = ChannelRequest {
            options: open.options,
            context: invocation.context.clone(),
            end,
        };
        // The service builds its future here; host code must not call this
        // application again, and what it spawns belongs to the host runtime.
        let opening = {
            let _opening = reentry::enter(self.key);
            let _runtime = self.runtime.as_ref().map(tokio::runtime::Handle::enter);
            service.open(request)
        };
        let id = invocation.handles.open_requested(guest, opening)?;
        // The open is polled at the next pump.
        self.wake.notify();
        Ok(Value::from(id))
    }

    fn write_channel(&self, input: &str) -> Result<Value> {
        let write: GuestWrite = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid channel write".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        let result = invocation
            .handles
            .write_channel(write, &mut invocation.bytes);
        self.wake.notify();
        result
    }

    fn pause_channel(&self, input: &str) -> Result<Value> {
        let pause: GuestPause = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid channel pause".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        let result = invocation.handles.pause_channel(pause);
        // Arrivals held back while paused are delivered at the next pump.
        self.wake.notify();
        result
    }

    fn send_channel(&self, input: &str) -> Result<Value> {
        let message: GuestMessage = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid channel message".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        let result = invocation
            .handles
            .send_channel(message, &mut invocation.bytes);
        // A close the send forced reaches JavaScript at the next poll.
        self.wake.notify();
        result
    }

    fn close_channel(&self, input: &str) -> Result<Value> {
        let close: GuestClose = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid channel close".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        invocation.handles.close_channel(close)
    }

    fn channel_buffered(&self, input: &str) -> Result<Value> {
        let id: u64 = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid channel id".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        invocation.handles.channel_buffered(id)
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

    /// Read the next chunk of a body source, or with `whole` the rest of it
    /// at once, which spares JavaScript a read per chunk and, as text, its
    /// own UTF-8 decoding.
    pub(super) fn read_body(&self, input: &str, whole: Option<Whole>) -> Result<Value> {
        let id: u64 = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid body id".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        if invocation.handles.body_mut(id).is_none() {
            return Err(Error::InvalidRequest("unknown body".into()));
        }
        // One read at a time, as a ReadableStream pulls.
        if invocation
            .pending_reads
            .values()
            .any(|reading| reading.id == id)
        {
            return Err(Error::InvalidRequest("body is already being read".into()));
        }
        let ticket = invocation.next_ticket()?;
        invocation
            .pending_reads
            .insert(ticket.clone(), PendingRead { id, whole });
        Ok(Value::String(ticket))
    }

    pub(super) fn cancel_body(&self, input: &str) -> Result<Value> {
        let id: u64 = serde_json::from_str(input)
            .map_err(|_| Error::InvalidRequest("invalid body id".into()))?;
        let mut state = self.lock_state()?;
        let invocation = state.invocation.as_mut().ok_or(Error::InvocationClosed)?;
        // Dropping the body cancels its producer. Cancelling twice is harmless.
        invocation.handles.release_body(id);
        invocation
            .pending_reads
            .retain(|_, reading| reading.id != id);
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

        if owns_invocation && let Some(mut invocation) = state.invocation.take() {
            // Releasing every handle drops the invocation's bodies and
            // channels, and keeps the table's generations for the next one.
            let mut handles = std::mem::take(&mut invocation.handles);
            handles.release_all();
            state.handles = handles;
        }
    }
}

/// Fetch's UTF-8 decode: a leading byte order mark is dropped, and each
/// maximal invalid subsequence becomes U+FFFD, as the Encoding Standard
/// specifies and `String::from_utf8_lossy` implements.
fn utf8_decode(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes))
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

/// An invocation's byte store, as `fetchlet-web` operations use it.
#[cfg(feature = "web")]
struct WebBytes<'a>(&'a mut ByteStore);

#[cfg(feature = "web")]
impl fetchlet_web::ByteHandles for WebBytes<'_> {
    type Error = Error;

    fn put(&mut self, bytes: Bytes) -> Result<u64> {
        self.0.put(bytes)
    }

    fn take(&mut self, handle: u64) -> Result<Bytes> {
        self.0.take(handle)
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

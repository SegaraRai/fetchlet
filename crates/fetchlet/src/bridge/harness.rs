use bytes::Bytes;
use serde_json::Value;

use super::{HostBridge, InvocationScope};
use crate::fetch::BodySender;
use crate::{
    Body, ChannelEnd, ChannelService, Error, HostServices, Limits, Result, SocketPolicy,
    SocketService, channel_fn, socket_fn,
};

/// Drives the host bridge as a guest would, for fuzz targets.
///
/// Operations take the same inputs as the native callbacks that engines
/// install: protocol messages, typed-array bytes and JavaScript numbers.
pub struct BridgeHarness {
    bridge: HostBridge,
    scope: Option<InvocationScope>,
}

impl BridgeHarness {
    pub fn new(services: HostServices) -> Self {
        Self {
            bridge: HostBridge::new(services),
            scope: None,
        }
    }

    /// End the current invocation, if any, and begin another.
    pub fn begin(&mut self, limits: Limits) -> Result<()> {
        self.scope = None;
        self.scope = Some(self.bridge.begin(limits)?);
        Ok(())
    }

    /// End the current invocation, releasing everything it owns.
    pub fn end(&mut self) {
        self.scope = None;
    }

    /// Whether host fetches of the current invocation are still pending.
    pub fn has_pending(&self) -> bool {
        self.scope
            .as_ref()
            .is_some_and(InvocationScope::has_pending)
    }

    /// The claimed host's `call(operation, input)`: the parsed reply.
    pub fn dispatch(&self, operation: &str, input: &str) -> Value {
        let reply = self.bridge.dispatch(operation.into(), input.into());
        serde_json::from_str(&reply).expect("replies are JSON")
    }

    /// The claimed host's `putBytes(view)`.
    pub fn put_guest_bytes(&self, bytes: &[u8]) -> Result<u64> {
        self.bridge.put_guest_bytes(bytes)
    }

    /// The claimed host's `takeBytes(handle)`.
    pub fn take_guest_bytes(&self, handle: f64) -> Result<Bytes> {
        self.bridge.take_guest_bytes(handle)
    }

    /// Let the current invocation read `body` on demand, as Rust does for a
    /// streamed request body.
    pub fn open_body(&self, body: Body, limit: Option<usize>) -> Result<u64> {
        self.bridge.open_body(body, limit, "request body bytes")
    }

    /// Open a streamed body whose producer the caller drives.
    pub fn open_fed_body(&self, capacity: usize, limit: Option<usize>) -> Result<(BodyFeed, u64)> {
        let (sender, body) = Body::channel(Bytes::new(), capacity.max(1));
        let id = self.open_body(body, limit)?;
        Ok((BodyFeed(sender), id))
    }
}

impl BridgeHarness {
    /// Accept a WebSocket upgrade in the current invocation, as a Fetch
    /// handler does for a request Rust lets it hold, through the guest's
    /// `websocket.upgrade` operation.
    pub fn open_connection(&self) -> Result<(ChannelFeed, u64)> {
        self.bridge.allow_upgrade()?;
        let reply = self.dispatch("websocket.upgrade", "null");
        let Some(id) = reply["value"].as_u64() else {
            return Err(Error::InvalidRequest(reply.to_string()));
        };
        Ok((ChannelFeed(self.bridge.take_upgrade(id)?), id))
    }
}

/// A channel service for fuzz targets. With `accept`, it accepts each open
/// at the first poll and hands Rust's end to the receiver as the open is
/// requested; otherwise it refuses each open with `PermissionDenied`.
pub fn harness_channel_service(
    accept: bool,
) -> (impl ChannelService, std::sync::mpsc::Receiver<ChannelFeed>) {
    let (feeds, received) = std::sync::mpsc::channel();
    let service = channel_fn(move |request| {
        let result = if accept {
            let _ = feeds.send(ChannelFeed(request.end));
            Ok(())
        } else {
            Err(Error::PermissionDenied)
        };
        async move { result }
    });
    (service, received)
}

/// A socket service for fuzz targets: its policy allows `open.test` on
/// ports 1 to 100, and its transport accepts each connect at the first poll,
/// handing Rust's end to the receiver as the connect is requested.
pub fn harness_socket_service() -> (SocketService, std::sync::mpsc::Receiver<ChannelFeed>) {
    let (feeds, received) = std::sync::mpsc::channel();
    let transport = socket_fn(move |request| {
        let _ = feeds.send(ChannelFeed(request.end));
        async { Ok(()) }
    });
    let policy = SocketPolicy::deny_all()
        .allow_ports("open.test", 1..=100)
        .expect("a valid rule");
    (SocketService::new(transport, policy), received)
}

/// Rust's end of a channel opened with [`BridgeHarness::open_connection`]
/// or through [`harness_channel_service`].
pub struct ChannelFeed(ChannelEnd);

impl ChannelFeed {
    /// Whether the bridge released JavaScript's end of the channel.
    pub fn is_released(&self) -> bool {
        self.0.peer_gone()
    }
}

/// The producer of a body opened with [`BridgeHarness::open_fed_body`].
/// Dropping it before the last chunk aborts the body.
pub struct BodyFeed(BodySender);

impl BodyFeed {
    /// Queue a chunk without waiting; false when the queue is full or the
    /// body was released.
    pub fn send(&self, chunk: &[u8], last: bool) -> bool {
        self.0
            .try_send(Ok((Bytes::copy_from_slice(chunk), last)))
            .is_ok()
    }

    /// Whether the bridge released the body, cancelling this producer.
    pub fn is_released(&self) -> bool {
        self.0.is_closed()
    }
}

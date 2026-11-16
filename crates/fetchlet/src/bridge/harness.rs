use bytes::Bytes;
use serde_json::Value;

use super::{HostBridge, InvocationScope};
use crate::fetch::BodySender;
use crate::{Body, HostServices, Limits, Result};

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

    /// `__fetchletHost(operation, input)`: the parsed reply.
    pub fn dispatch(&self, operation: &str, input: &str) -> Value {
        let reply = self.bridge.dispatch(operation.into(), input.into());
        serde_json::from_str(&reply).expect("replies are JSON")
    }

    /// `__fetchletPutBytes(view)`.
    pub fn put_guest_bytes(&self, bytes: &[u8]) -> Result<u64> {
        self.bridge.put_guest_bytes(bytes)
    }

    /// `__fetchletTakeBytes(handle)`.
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

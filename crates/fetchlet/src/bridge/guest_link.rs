use bytes::Bytes;

use super::HostBridge;
use crate::Result;
use crate::execution::WakeSignal;

/// What an engine reaches the host through: host operations, the
/// invocation's byte store and the notification it waits on between host
/// steps. Everything else of the bridge, the invocation's lifecycle, its
/// bodies, channels and budgets, belongs to `App`, not to the engine.
///
/// Keeping this surface narrow is what lets an engine run apart from the
/// bridge, in a child process
/// (docs/research/process-isolation.md#where-the-boundary-goes).
#[derive(Clone)]
#[cfg_attr(
    fetchlet_process,
    expect(
        clippy::large_enum_variant,
        reason = "an engine holds one link for its lifetime, so the size costs nothing per call"
    )
)]
pub(crate) enum GuestLink {
    /// The bridge in the engine's own process.
    Local(HostBridge),
    /// The bridge in the parent of an isolated instance's process.
    #[cfg(fetchlet_process)]
    Remote(std::sync::Arc<crate::isolation::RemoteLink>),
}

impl Default for GuestLink {
    /// A bridge with no host services, for engines built directly.
    fn default() -> Self {
        Self::Local(HostBridge::default())
    }
}

impl From<HostBridge> for GuestLink {
    fn from(bridge: HostBridge) -> Self {
        Self::Local(bridge)
    }
}

impl GuestLink {
    /// Run a host operation: its name and JSON input, a JSON reply.
    pub fn dispatch(&self, operation: String, input: String) -> String {
        match self {
            Self::Local(bridge) => bridge.dispatch(operation, input),
            #[cfg(fetchlet_process)]
            Self::Remote(link) => link.dispatch(operation, input),
        }
    }

    /// Copy bytes from a JavaScript typed array into the current
    /// invocation's byte store; returns their handle.
    pub fn put_guest_bytes(&self, bytes: &[u8]) -> Result<u64> {
        match self {
            Self::Local(bridge) => bridge.put_guest_bytes(bytes),
            #[cfg(fetchlet_process)]
            Self::Remote(link) => link.put_guest_bytes(bytes),
        }
    }

    /// Take bytes from the current invocation's byte store, by a handle
    /// that a JavaScript number carried.
    pub fn take_guest_bytes(&self, handle: f64) -> Result<Bytes> {
        match self {
            Self::Local(bridge) => bridge.take_guest_bytes(handle),
            #[cfg(fetchlet_process)]
            Self::Remote(link) => link.take_guest_bytes(handle),
        }
    }

    /// The notification that wakes the engine when a host future it waits
    /// on is ready.
    pub fn wake_signal(&self) -> WakeSignal {
        match self {
            Self::Local(bridge) => bridge.wake_signal(),
            #[cfg(fetchlet_process)]
            Self::Remote(link) => link.wake_signal(),
        }
    }
}

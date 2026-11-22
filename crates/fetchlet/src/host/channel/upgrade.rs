use std::sync::{Arc, Mutex};

use super::ChannelEnd;

/// The response extension of a Fetch handler that accepted a WebSocket
/// upgrade with `upgradeWebSocket(request)`.
///
/// The response has status 101 and the headers JavaScript chose, such as
/// `Sec-WebSocket-Protocol`. The HTTP integration completes the handshake
/// and carries frames between the upgraded connection and the
/// [`ChannelEnd`]. A caller that is not an HTTP server can talk to the
/// socket through the end directly. The invocation and its instance stay
/// held until the channel closes.
#[derive(Clone)]
pub struct ServerWebSocket {
    end: Arc<Mutex<Option<ChannelEnd>>>,
}

impl ServerWebSocket {
    pub(crate) fn new(end: ChannelEnd) -> Self {
        Self {
            end: Arc::new(Mutex::new(Some(end))),
        }
    }

    /// Rust's end of the socket's channel; None after the first call.
    pub fn take(&self) -> Option<ChannelEnd> {
        self.end
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

impl std::fmt::Debug for ServerWebSocket {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServerWebSocket")
            .finish_non_exhaustive()
    }
}

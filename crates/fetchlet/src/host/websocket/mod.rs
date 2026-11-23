#[cfg_attr(
    not(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing"
    )),
    allow(dead_code)
)]
mod service;

pub use service::{
    WebSocketAccept, WebSocketFuture, WebSocketRequest, WebSocketService, WebSocketTransport,
    websocket_fn,
};

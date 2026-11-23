//! Explicit host services and the policies applied before transport dispatch.

mod bindings;
mod channel;
mod console;
mod context;
mod function;
mod policy;
mod router;
mod service;
mod socket;
mod transport;
mod websocket;

pub use bindings::HostServices;
pub use channel::{
    ChannelEnd, ChannelEvent, ChannelFuture, ChannelRequest, ChannelService, CloseFrame, Message,
    ServerWebSocket, channel_fn,
};
pub use console::ConsoleLevel;
pub use context::Context;
pub use function::{FunctionError, FunctionFuture, FunctionRequest, FunctionResponse, Functions};
pub use policy::FetchPolicy;
pub use router::OriginRouter;
pub use service::FetchService;
pub use socket::{
    SecureTransport, SocketAddress, SocketPolicy, SocketRequest, SocketService, SocketTransport,
    socket_fn,
};
pub use transport::{FetchTransport, RequireHttp2, TransportFuture, transport_fn};
pub use websocket::{
    WebSocketAccept, WebSocketFuture, WebSocketRequest, WebSocketService, WebSocketTransport,
    websocket_fn,
};

pub(crate) use channel::{GuestEnd, pair};

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use channel::Refused;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use function::Method;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use service::Redirect;

#[cfg(test)]
mod tests;

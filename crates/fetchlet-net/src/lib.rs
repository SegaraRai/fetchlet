//! Outbound network transports for fetchlet applications.
//!
//! The `sockets` feature adds [`TcpTransport`], which opens the TCP and TLS
//! connections of JavaScript's `connect()` for a `SocketService`, and the
//! `websocket` feature adds [`WebSocketClient`], which opens the connections
//! of JavaScript's `WebSocket` for a `WebSocketService`. Both resolve names,
//! refuse non-public addresses unless allowed and speak TLS with rustls.
//! The JavaScript engine is chosen on the `fetchlet` crate.

#[cfg(any(feature = "sockets", feature = "websocket"))]
mod network;
#[cfg(feature = "sockets")]
mod socket;
#[cfg(feature = "websocket")]
mod websocket;

#[cfg(any(feature = "sockets", feature = "websocket"))]
pub use network::rustls;
#[cfg(feature = "sockets")]
pub use socket::TcpTransport;
#[cfg(feature = "websocket")]
pub use websocket::WebSocketClient;

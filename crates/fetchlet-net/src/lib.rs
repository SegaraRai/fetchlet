//! Outbound network transports for fetchlet applications.
//!
//! The `http` feature adds [`HttpClient`], which sends JavaScript's outbound
//! `fetch` requests as a `FetchTransport`; the `sockets` feature adds
//! [`TcpTransport`], which opens the TCP and TLS connections of JavaScript's
//! `connect()` for a `SocketService`; and the `websocket` feature adds
//! [`WebSocketClient`], which opens the connections of JavaScript's
//! `WebSocket` for a `WebSocketService`. Each resolves names, refuses
//! non-public addresses unless allowed and speaks TLS with rustls.
//! The JavaScript engine is chosen on the `fetchlet` crate.

#[cfg(feature = "http")]
mod http;
#[cfg(any(feature = "http", feature = "sockets", feature = "websocket"))]
mod network;
#[cfg(feature = "sockets")]
mod socket;
#[cfg(feature = "websocket")]
mod websocket;

#[cfg(feature = "http")]
pub use http::HttpClient;
#[cfg(any(feature = "http", feature = "sockets", feature = "websocket"))]
pub use network::rustls;
#[cfg(feature = "sockets")]
pub use socket::TcpTransport;
#[cfg(feature = "websocket")]
pub use websocket::WebSocketClient;

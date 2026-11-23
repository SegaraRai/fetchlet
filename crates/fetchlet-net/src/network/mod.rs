// Name resolution, address checks, TCP and TLS shared by the network
// transports of JavaScript's sockets and client WebSockets.

mod address;
mod connector;

#[cfg(feature = "sockets")]
pub(crate) use connector::server_name;
pub(crate) use connector::{Connector, runtime};
pub use tokio_rustls::rustls;

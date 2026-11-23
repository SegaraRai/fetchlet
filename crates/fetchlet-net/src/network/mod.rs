// Name resolution, address checks, TCP and TLS shared by the network
// transports of JavaScript's fetch, sockets and client WebSockets.

mod address;
mod connector;

pub use tokio_rustls::rustls;

pub(crate) use connector::{Connector, runtime};

#[cfg(feature = "sockets")]
pub(crate) use connector::server_name;

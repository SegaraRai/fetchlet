// Name resolution, address checks, TCP and TLS shared by the network
// transports of JavaScript's sockets and client WebSockets.

mod address;
mod connector;

pub(crate) use connector::{Connector, runtime, server_name};
pub use tokio_rustls::rustls;

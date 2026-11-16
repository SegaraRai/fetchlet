//! hyper 1 services backed by a shared fetchlet application.
//!
//! The integration itself is the generic Tower service of `fetchlet-tower`;
//! this crate implements hyper's service trait and records the peer address
//! of each connection.

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod integration;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use fetchlet_tower::{Error, RequestContext, service_transport};
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use integration::{Connection, FetchletService, PeerAddr, peer_addr};

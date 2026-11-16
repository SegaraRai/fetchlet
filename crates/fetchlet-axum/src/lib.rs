//! axum services backed by a shared fetchlet application.
//!
//! The integration itself is the generic Tower service of `fetchlet-tower`;
//! this crate reads axum's `ConnectInfo` and converts bodies to axum's types.

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod integration;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use fetchlet_tower::{Error, RequestContext, service_transport};
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use integration::{FetchletService, connect_info, router_transport};

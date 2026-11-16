//! axum services backed by a shared fetchlet application.

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod integration;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use integration::{Error, FetchletService, RequestContext, router_transport};

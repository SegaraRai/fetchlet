//! Tower services and `http` types backed by a shared fetchlet application.

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod integration;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use integration::{
    BoxError, Error, FetchletService, PublicOrigin, RequestContext, service_transport,
};

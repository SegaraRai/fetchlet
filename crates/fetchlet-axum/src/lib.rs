//! axum services backed by a shared fetchlet application.

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
mod integration;

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
pub use integration::{Error, FetchletService, RequestContext};

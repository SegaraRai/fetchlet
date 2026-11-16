//! actix-web handlers backed by a shared fetchlet application.

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod integration;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use fetchlet_tower::{Error, RequestContext};
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use integration::FetchletService;

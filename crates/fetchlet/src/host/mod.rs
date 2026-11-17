//! Explicit host services and the policies applied before transport dispatch.

mod bindings;
mod console;
mod context;
mod policy;
mod router;
mod service;
mod transport;

pub use bindings::HostServices;
pub use console::ConsoleLevel;
pub use context::Context;
pub use policy::FetchPolicy;
pub use router::OriginRouter;
pub use service::FetchService;
pub use transport::{FetchTransport, TransportFuture, transport_fn};

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use service::Redirect;

#[cfg(test)]
mod tests;

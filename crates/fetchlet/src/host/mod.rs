//! Explicit host services and the policies applied before transport dispatch.

mod bindings;
mod policy;
mod service;
mod transport;

pub use bindings::HostServices;
pub use policy::FetchPolicy;
pub use service::FetchService;
pub use transport::{FetchTransport, TransportFuture, transport_fn};

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8", test))]
pub(crate) use service::Redirect;

#[cfg(test)]
mod tests;

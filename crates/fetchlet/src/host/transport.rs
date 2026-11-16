use std::future::Future;
use std::pin::Pin;

use crate::{Request, Response, Result};

pub type TransportFuture = Pin<Box<dyn Future<Output = Result<Response>> + Send + 'static>>;

/// A trusted, single-hop transport.
///
/// Dropping its future must cancel its work. Implementations must not detach I/O
/// or follow redirects. A network implementation must additionally enforce its
/// resolved-address policy at connection time; an origin allowlist is not DNS
/// or private-network isolation.
pub trait FetchTransport: Send + Sync + 'static {
    fn send(&self, request: Request) -> TransportFuture;
}

struct FunctionTransport<F>(F);

impl<F, Fut> FetchTransport for FunctionTransport<F>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Response>> + Send + 'static,
{
    fn send(&self, request: Request) -> TransportFuture {
        Box::pin((self.0)(request))
    }
}

/// Adapt an async Rust function, including a mock, to a host transport.
pub fn transport_fn<F, Fut>(function: F) -> impl FetchTransport
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Response>> + Send + 'static,
{
    FunctionTransport(function)
}

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::{Request, Response, Result};

pub type TransportFuture = Pin<Box<dyn Future<Output = Result<Response>> + Send + 'static>>;

/// A request extension that `FetchService` adds when the request's body
/// streams and its policy does not allow that over HTTP/1.x
/// ([`FetchPolicy::allow_http1_streaming`](crate::FetchPolicy::allow_http1_streaming)).
///
/// A network transport must then send the request over HTTP/2 or later, or
/// fail it without sending it, as a browser fails a streaming upload on an
/// HTTP/1.x connection. A transport that answers in-process has no
/// connection to choose and may ignore it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequireHttp2;

/// A trusted, single-hop transport.
///
/// Dropping its future must cancel its work. Implementations must not detach I/O
/// or follow redirects. A network implementation must additionally enforce its
/// resolved-address policy at connection time; an origin allowlist is not DNS
/// or private-network isolation.
pub trait FetchTransport: Send + Sync + 'static {
    fn send(&self, request: Request) -> TransportFuture;
}

/// Share one transport, such as a network client, between services or routes.
impl<T: FetchTransport + ?Sized> FetchTransport for Arc<T> {
    fn send(&self, request: Request) -> TransportFuture {
        (**self).send(request)
    }
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

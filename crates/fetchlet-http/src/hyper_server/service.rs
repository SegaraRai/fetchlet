use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;

use http::request::Parts;
use http::{Request, Response};
use hyper::body::Incoming;
use serde::Serialize;

use fetchlet::AppHandle;

use crate::{Error, FetchletService};

type ResponseFuture =
    Pin<Box<dyn Future<Output = Result<Response<fetchlet::Body>, Infallible>> + Send>>;

/// The peer address of the connection a request arrived on.
///
/// [`HyperConnection`] inserts it into each request's extensions.
#[derive(Clone, Copy, Debug)]
pub struct PeerAddr(pub SocketAddr);

/// The client address recorded by [`HyperService::connection`].
pub fn peer_addr(parts: &Parts) -> Option<IpAddr> {
    parts
        .extensions
        .get::<PeerAddr>()
        .map(|PeerAddr(address)| address.ip())
}

/// [`FetchletService`] as a hyper 1 service.
///
/// Serve each accepted connection with [`HyperService::connection`] so the
/// default context's client address is the peer address. The service itself
/// also implements hyper's trait, for connections without a peer address.
/// Everything else, including the public origin, body budgets, the trusted
/// Context and error responses, is the Tower service's behavior.
#[derive(Clone)]
pub struct HyperService {
    inner: FetchletService,
}

impl HyperService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        let inner = FetchletService::new(app, public_origin)?.client_address(peer_addr);
        Ok(Self { inner })
    }

    /// The service for one connection from `peer`.
    pub fn connection(&self, peer: SocketAddr) -> HyperConnection {
        HyperConnection {
            inner: self.inner.clone(),
            peer: Some(PeerAddr(peer)),
        }
    }

    /// See [`FetchletService::context`].
    pub fn context<C, F>(self, context: F) -> Self
    where
        C: Serialize,
        F: Fn(&Parts) -> C + Send + Sync + 'static,
    {
        self.map(|inner| inner.context(context))
    }

    /// See [`FetchletService::trusted_context`].
    pub fn trusted_context(
        self,
        context: impl Fn(&Parts) -> fetchlet::Context + Send + Sync + 'static,
    ) -> Self {
        self.map(|inner| inner.trusted_context(context))
    }

    /// See [`FetchletService::on_error`].
    pub fn on_error(self, callback: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.map(|inner| inner.on_error(callback))
    }

    /// See [`FetchletService::stream_request_bodies`].
    pub fn stream_request_bodies(self) -> Self {
        self.map(FetchletService::stream_request_bodies)
    }

    /// The underlying Tower service.
    pub fn into_inner(self) -> FetchletService {
        self.inner
    }

    fn map(self, change: impl FnOnce(FetchletService) -> FetchletService) -> Self {
        Self {
            inner: change(self.inner),
        }
    }
}

impl hyper::service::Service<Request<Incoming>> for HyperService {
    type Response = Response<fetchlet::Body>;

    type Error = Infallible;

    type Future = ResponseFuture;

    fn call(&self, request: Request<Incoming>) -> Self::Future {
        respond(self.inner.clone(), request)
    }
}

/// [`HyperService`] for one connection, recording its peer address.
#[derive(Clone)]
pub struct HyperConnection {
    inner: FetchletService,
    peer: Option<PeerAddr>,
}

impl hyper::service::Service<Request<Incoming>> for HyperConnection {
    type Response = Response<fetchlet::Body>;

    type Error = Infallible;

    type Future = ResponseFuture;

    fn call(&self, mut request: Request<Incoming>) -> Self::Future {
        if let Some(peer) = self.peer {
            request.extensions_mut().insert(peer);
        }
        respond(self.inner.clone(), request)
    }
}

/// Dropping the future, as hyper does when the client disconnects, cancels
/// the invocation.
fn respond(service: FetchletService, request: Request<Incoming>) -> ResponseFuture {
    Box::pin(async move {
        Ok(match service.fetch(request).await {
            Ok(response) => response,
            Err(error) => service.error_response(&error),
        })
    })
}

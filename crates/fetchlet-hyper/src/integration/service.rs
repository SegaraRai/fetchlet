use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;

use http::request::Parts;
use http::{Request, Response};
use hyper::body::Incoming;
use serde::Serialize;

use fetchlet::AppHandle;
use fetchlet_tower::Error;

type ResponseFuture =
    Pin<Box<dyn Future<Output = Result<Response<fetchlet::Body>, Infallible>> + Send>>;

/// The peer address of the connection a request arrived on.
///
/// [`Connection`] inserts it into each request's extensions.
#[derive(Clone, Copy, Debug)]
pub struct PeerAddr(pub SocketAddr);

/// The client address recorded by [`FetchletService::connection`].
pub fn peer_addr(parts: &Parts) -> Option<IpAddr> {
    parts
        .extensions
        .get::<PeerAddr>()
        .map(|PeerAddr(address)| address.ip())
}

/// [`fetchlet_tower::FetchletService`] as a hyper 1 service.
///
/// Serve each accepted connection with [`FetchletService::connection`] so the
/// default context's client address is the peer address. The service itself
/// also implements hyper's trait, for connections without a peer address.
/// Everything else, including the public origin, body budgets, the trusted
/// Context and error responses, is the Tower service's behavior.
#[derive(Clone)]
pub struct FetchletService {
    inner: fetchlet_tower::FetchletService,
}

impl FetchletService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        let inner =
            fetchlet_tower::FetchletService::new(app, public_origin)?.client_address(peer_addr);
        Ok(Self { inner })
    }

    /// The service for one connection from `peer`.
    pub fn connection(&self, peer: SocketAddr) -> Connection {
        Connection {
            inner: self.inner.clone(),
            peer: Some(PeerAddr(peer)),
        }
    }

    /// See [`fetchlet_tower::FetchletService::context`].
    pub fn context<C, F>(self, context: F) -> Self
    where
        C: Serialize,
        F: Fn(&Parts) -> C + Send + Sync + 'static,
    {
        self.map(|inner| inner.context(context))
    }

    /// See [`fetchlet_tower::FetchletService::trusted_context`].
    pub fn trusted_context(
        self,
        context: impl Fn(&Parts) -> fetchlet::Context + Send + Sync + 'static,
    ) -> Self {
        self.map(|inner| inner.trusted_context(context))
    }

    /// See [`fetchlet_tower::FetchletService::on_error`].
    pub fn on_error(self, callback: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.map(|inner| inner.on_error(callback))
    }

    /// See [`fetchlet_tower::FetchletService::stream_request_bodies`].
    pub fn stream_request_bodies(self) -> Self {
        self.map(fetchlet_tower::FetchletService::stream_request_bodies)
    }

    /// The underlying Tower service.
    pub fn into_inner(self) -> fetchlet_tower::FetchletService {
        self.inner
    }

    fn map(
        self,
        change: impl FnOnce(fetchlet_tower::FetchletService) -> fetchlet_tower::FetchletService,
    ) -> Self {
        Self {
            inner: change(self.inner),
        }
    }
}

impl hyper::service::Service<Request<Incoming>> for FetchletService {
    type Response = Response<fetchlet::Body>;

    type Error = Infallible;

    type Future = ResponseFuture;

    fn call(&self, request: Request<Incoming>) -> Self::Future {
        respond(self.inner.clone(), request)
    }
}

/// [`FetchletService`] for one connection, recording its peer address.
#[derive(Clone)]
pub struct Connection {
    inner: fetchlet_tower::FetchletService,
    peer: Option<PeerAddr>,
}

impl hyper::service::Service<Request<Incoming>> for Connection {
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
fn respond(service: fetchlet_tower::FetchletService, request: Request<Incoming>) -> ResponseFuture {
    Box::pin(async move {
        Ok(match service.fetch(request).await {
            Ok(response) => response,
            Err(error) => service.error_response(&error),
        })
    })
}

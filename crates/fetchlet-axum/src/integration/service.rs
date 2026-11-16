use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::request::Parts;
use axum::response::Response;
use serde::Serialize;
use tower_service::Service;

use fetchlet::AppHandle;
use fetchlet_tower::Error;

/// The client address recorded by `into_make_service_with_connect_info`.
pub fn connect_info(parts: &Parts) -> Option<IpAddr> {
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip())
}

/// [`fetchlet_tower::FetchletService`] with axum's request and response types.
///
/// The default context's client address comes from `ConnectInfo<SocketAddr>`.
/// Everything else, including the public origin, body budgets, the trusted
/// Context and error responses, is the Tower service's behavior.
#[derive(Clone)]
pub struct FetchletService {
    inner: fetchlet_tower::FetchletService,
}

impl FetchletService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        let inner =
            fetchlet_tower::FetchletService::new(app, public_origin)?.client_address(connect_info);
        Ok(Self { inner })
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

    /// Run the handler, returning detailed errors.
    pub async fn fetch(&self, request: Request) -> Result<Response, Error> {
        Ok(self.inner.fetch(request).await?.map(Body::new))
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

impl Service<Request> for FetchletService {
    type Response = Response;

    type Error = Infallible;

    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let service = self.inner.clone();
        Box::pin(async move {
            let response = match service.fetch(request).await {
                Ok(response) => response,
                Err(error) => service.error_response(&error),
            };
            Ok(response.map(Body::new))
        })
    }
}

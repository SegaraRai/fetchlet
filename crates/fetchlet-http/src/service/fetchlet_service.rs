use std::convert::Infallible;
use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::request::Parts;
use http::{Request, Response};
use http_body_util::{BodyExt, Limited};
use serde::Serialize;
use serde_json::Value;
use tower_service::Service;

use fetchlet::AppHandle;

use super::{BoxError, Error, PublicOrigin, RequestContext};

type ContextFactory = Arc<dyn Fn(&Parts) -> Result<Value, Error> + Send + Sync>;

type AddressFactory = Arc<dyn Fn(&Parts) -> Option<IpAddr> + Send + Sync>;

type TrustedContextFactory = Arc<dyn Fn(&Parts) -> fetchlet::Context + Send + Sync>;

type ErrorCallback = Arc<dyn Fn(&Error) + Send + Sync>;

/// A cloneable Tower service for a shared fetchlet application.
///
/// It accepts `http::Request<B>` for any body with `Bytes` data and returns
/// `http::Response<fetchlet::Body>`, so it serves hyper connections and axum
/// routers alike. The configured public origin supplies the scheme and
/// authority; the incoming path, query, method, headers and body are kept. By
/// default the incoming body is collected within the application's request
/// body budget before the handler runs; [`FetchletService::stream_request_bodies`]
/// passes it as a stream.
#[derive(Clone)]
pub struct FetchletService {
    app: AppHandle,
    origin: PublicOrigin,
    context: Option<ContextFactory>,
    client_address: Option<AddressFactory>,
    trusted_context: Option<TrustedContextFactory>,
    on_error: Option<ErrorCallback>,
    stream_request_bodies: bool,
}

impl FetchletService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        Ok(Self {
            app,
            origin: PublicOrigin::parse(public_origin)?,
            context: None,
            client_address: None,
            trusted_context: None,
            on_error: None,
            stream_request_bodies: false,
        })
    }

    #[cfg(feature = "axum-websocket")]
    pub(crate) fn app(&self) -> &AppHandle {
        &self.app
    }

    /// Supply the client address of the default [`RequestContext`].
    ///
    /// Servers keep connection data in their own request extensions, such as
    /// axum's `ConnectInfo`; this callback reads it.
    pub fn client_address(
        mut self,
        address: impl Fn(&Parts) -> Option<IpAddr> + Send + Sync + 'static,
    ) -> Self {
        self.client_address = Some(Arc::new(address));
        self
    }

    /// Supply application metadata using the incoming HTTP request parts.
    ///
    /// It replaces the default [`RequestContext`] as the Fetch entry's second
    /// argument, which JavaScript reads.
    pub fn context<C, F>(mut self, context: F) -> Self
    where
        C: Serialize,
        F: Fn(&Parts) -> C + Send + Sync + 'static,
    {
        self.context = Some(Arc::new(move |parts| {
            serde_json::to_value(context(parts)).map_err(Error::Context)
        }));
        self
    }

    /// Derive the trusted [`fetchlet::Context`] of each request in Rust.
    ///
    /// The Context stays out of JavaScript. Host fetches of the request carry
    /// it to in-process routes registered with
    /// [`fetchlet::OriginRouter::internal`], for example a router served
    /// through [`service_transport`](crate::service_transport). Use it for the
    /// authenticated principal, tenant or trace data instead of request
    /// headers that JavaScript can set. It replaces a Context that earlier
    /// middleware put in the request extensions.
    pub fn trusted_context(
        mut self,
        context: impl Fn(&Parts) -> fetchlet::Context + Send + Sync + 'static,
    ) -> Self {
        self.trusted_context = Some(Arc::new(context));
        self
    }

    /// Observe detailed errors in Rust while HTTP responses use general messages.
    pub fn on_error(mut self, callback: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.on_error = Some(Arc::new(callback));
        self
    }

    /// Pass incoming bodies to the handler as a stream instead of collecting them.
    ///
    /// The handler starts before the body has arrived and reads it as a
    /// `ReadableStream`. A declared `Content-Length` over the request body
    /// budget is still rejected with 413 before execution. Bytes over the
    /// budget without a declared length, and failures of the incoming body,
    /// reach the handler as errors of its body stream, so the handler decides
    /// the response status.
    pub fn stream_request_bodies(mut self) -> Self {
        self.stream_request_bodies = true;
        self
    }

    /// Run the handler, returning detailed errors.
    pub async fn fetch<B>(&self, request: Request<B>) -> Result<Response<fetchlet::Body>, Error>
    where
        B: http_body::Body<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError> + fmt::Display,
    {
        let (mut parts, body) = request.into_parts();
        parts.uri = self.origin.apply(parts.uri)?;
        let context = self.context_value(&parts)?;
        if let Some(trusted) = &self.trusted_context {
            let trusted = trusted(&parts);
            parts.extensions.insert(trusted);
        }
        let body = if self.stream_request_bodies {
            // The invocation applies the budget to the bytes it reads.
            fetchlet::Body::from_http_body(body)
        } else {
            // None delegates the budget to the host.
            let limit = self.app.limits().request_body_bytes.unwrap_or(usize::MAX);
            let collected = Limited::new(body, limit)
                .collect()
                .await
                .map_err(Error::Body)?;
            fetchlet::Body::from(collected.to_bytes())
        };
        let request = Request::from_parts(parts, body);
        Ok(self.app.fetch_with_context(request, &context).await?)
    }

    fn context_value(&self, parts: &Parts) -> Result<Value, Error> {
        if let Some(context) = &self.context {
            return context(parts);
        }
        let address = self
            .client_address
            .as_ref()
            .and_then(|address| address(parts));
        serde_json::to_value(RequestContext::new(address)).map_err(Error::Context)
    }

    /// Report an error to the callback and answer with a general response.
    pub fn error_response(&self, error: &Error) -> Response<fetchlet::Body> {
        if let Some(callback) = &self.on_error {
            callback(error);
        }
        error.response()
    }
}

impl<B> Service<Request<B>> for FetchletService
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError> + fmt::Display,
{
    type Response = Response<fetchlet::Body>;

    type Error = Infallible;

    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        let service = self.clone();
        Box::pin(async move {
            Ok(match service.fetch(request).await {
                Ok(response) => response,
                Err(error) => service.error_response(&error),
            })
        })
    }
}

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::Value;
use tower_service::Service;

use fetchlet::AppHandle;

use super::origin::Origin;
use super::{Error, RequestContext};

type ContextFactory = Arc<dyn Fn(&Parts) -> Result<Value, Error> + Send + Sync>;

type TrustedContextFactory = Arc<dyn Fn(&Parts) -> fetchlet::Context + Send + Sync>;

type ErrorCallback = Arc<dyn Fn(&Error) + Send + Sync>;

/// A cloneable axum service for a shared fetchlet application.
///
/// The configured public origin supplies the scheme and authority. The incoming
/// path, query, method, headers and body are preserved. By default the incoming
/// body is collected within the application's request body budget before the
/// handler runs; [`FetchletService::stream_request_bodies`] passes it as a stream.
#[derive(Clone)]
pub struct FetchletService {
    app: AppHandle,
    origin: Origin,
    context: ContextFactory,
    trusted_context: Option<TrustedContextFactory>,
    on_error: Option<ErrorCallback>,
    stream_request_bodies: bool,
}

impl FetchletService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        Ok(Self {
            app,
            origin: Origin::parse(public_origin)?,
            context: Arc::new(|parts| {
                serde_json::to_value(RequestContext::from_parts(parts)).map_err(Error::Context)
            }),
            trusted_context: None,
            on_error: None,
            stream_request_bodies: false,
        })
    }

    /// Supply application metadata using the incoming HTTP request parts.
    pub fn context<C, F>(mut self, context: F) -> Self
    where
        C: Serialize,
        F: Fn(&Parts) -> C + Send + Sync + 'static,
    {
        self.context =
            Arc::new(move |parts| serde_json::to_value(context(parts)).map_err(Error::Context));
        self
    }

    /// Derive the trusted [`fetchlet::Context`] of each request in Rust.
    ///
    /// The Context stays out of JavaScript. Host fetches of the request carry
    /// it to in-process routes registered with
    /// [`fetchlet::OriginRouter::internal`], for example an axum router served
    /// through [`router_transport`](crate::router_transport). Use it for the
    /// authenticated principal, tenant or trace data instead of request headers
    /// that JavaScript can set.
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

    pub async fn fetch(&self, request: Request) -> Result<Response, Error> {
        let (mut parts, body) = request.into_parts();
        parts.uri = self.origin.apply(parts.uri)?;
        let context = (self.context)(&parts)?;
        if let Some(trusted) = &self.trusted_context {
            let trusted = trusted(&parts);
            parts.extensions.insert(trusted);
        }
        let body = if self.stream_request_bodies {
            // The invocation applies the budget to the bytes it reads.
            fetchlet::Body::from_http_body(body)
        } else {
            // None delegates the budget to the host; axum takes a concrete capacity.
            let limit = self.app.limits().request_body_bytes.unwrap_or(usize::MAX);
            fetchlet::Body::from(to_bytes(body, limit).await.map_err(Error::Body)?)
        };
        let request = fetchlet::Request::from_parts(parts, body);
        let response = self.app.fetch_with_context(request, &context).await?;
        Ok(response.map(Body::new))
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
        let service = self.clone();
        Box::pin(async move {
            let response = match service.fetch(request).await {
                Ok(response) => response,
                Err(error) => {
                    if let Some(callback) = &service.on_error {
                        callback(&error);
                    }
                    error.into_response()
                }
            };
            Ok(response)
        })
    }
}

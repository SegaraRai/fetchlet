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

type ErrorCallback = Arc<dyn Fn(&Error) + Send + Sync>;

/// A cloneable axum service for a shared fetchlet application.
///
/// The configured public origin supplies the scheme and authority. The incoming
/// path, query, method, headers and body are preserved. The application's request
/// body budget is applied while collecting the incoming body.
#[derive(Clone)]
pub struct FetchletService {
    app: AppHandle,
    origin: Origin,
    context: ContextFactory,
    on_error: Option<ErrorCallback>,
}

impl FetchletService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        Ok(Self {
            app,
            origin: Origin::parse(public_origin)?,
            context: Arc::new(|parts| {
                serde_json::to_value(RequestContext::from_parts(parts)).map_err(Error::Context)
            }),
            on_error: None,
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

    /// Observe detailed errors in Rust while HTTP responses use general messages.
    pub fn on_error(mut self, callback: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.on_error = Some(Arc::new(callback));
        self
    }

    pub async fn fetch(&self, request: Request) -> Result<Response, Error> {
        let (mut parts, body) = request.into_parts();
        parts.uri = self.origin.apply(parts.uri)?;
        let context = (self.context)(&parts)?;
        // None delegates the budget to the host; axum takes a concrete capacity.
        let body = to_bytes(
            body,
            self.app.limits().request_body_bytes.unwrap_or(usize::MAX),
        )
        .await
        .map_err(Error::Body)?;
        let request = fetchlet::Request::from_parts(parts, fetchlet::Body::from(body));
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

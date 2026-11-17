use std::sync::Arc;

use actix_web::{HttpRequest, HttpResponse, Route, web};
use serde::Serialize;
use serde_json::Value;

use fetchlet::AppHandle;

use super::body::{ForwardedBody, collect};
use super::convert::{declared_body, request_head, response};
use crate::{Error, PublicOrigin, RequestContext};

type ContextFactory = Arc<dyn Fn(&HttpRequest) -> Result<Value, Error> + Send + Sync>;

type TrustedContextFactory = Arc<dyn Fn(&HttpRequest) -> fetchlet::Context + Send + Sync>;

type ErrorCallback = Arc<dyn Fn(&Error) + Send + Sync>;

/// An actix-web handler for a shared fetchlet application.
///
/// The configured public origin supplies the scheme and authority; the
/// incoming path, query, method, headers and body are kept. The default
/// context's client address is the peer address. By default the payload is
/// collected within the application's request body budget before the handler
/// runs; [`ActixService::stream_request_bodies`] passes it as a stream.
/// Responses keep repeated headers such as Set-Cookie and stream their bodies.
/// Dropping the request, for example when the client disconnects, cancels the
/// invocation.
#[derive(Clone)]
pub struct ActixService {
    app: AppHandle,
    origin: PublicOrigin,
    context: Option<ContextFactory>,
    trusted_context: Option<TrustedContextFactory>,
    on_error: Option<ErrorCallback>,
    stream_request_bodies: bool,
}

impl ActixService {
    pub fn new(app: AppHandle, public_origin: &str) -> Result<Self, Error> {
        Ok(Self {
            app,
            origin: PublicOrigin::parse(public_origin)?,
            context: None,
            trusted_context: None,
            on_error: None,
            stream_request_bodies: false,
        })
    }

    /// Supply application metadata, the Fetch entry's second argument, in
    /// place of the default [`RequestContext`].
    pub fn context<C, F>(mut self, context: F) -> Self
    where
        C: Serialize,
        F: Fn(&HttpRequest) -> C + Send + Sync + 'static,
    {
        self.context = Some(Arc::new(move |request| {
            serde_json::to_value(context(request)).map_err(Error::Context)
        }));
        self
    }

    /// Derive the trusted [`fetchlet::Context`] of each request in Rust.
    ///
    /// The Context stays out of JavaScript and reaches in-process routes
    /// registered with [`fetchlet::OriginRouter::internal`].
    pub fn trusted_context(
        mut self,
        context: impl Fn(&HttpRequest) -> fetchlet::Context + Send + Sync + 'static,
    ) -> Self {
        self.trusted_context = Some(Arc::new(context));
        self
    }

    /// Observe detailed errors in Rust while HTTP responses use general messages.
    pub fn on_error(mut self, callback: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.on_error = Some(Arc::new(callback));
        self
    }

    /// Pass incoming payloads to the handler as a stream instead of collecting them.
    ///
    /// A declared `Content-Length` over the request body budget is still
    /// rejected with 413 before execution. Bytes over the budget without a
    /// declared length, and payload failures, reach the handler as errors of
    /// its body stream, so the handler decides the response status.
    pub fn stream_request_bodies(mut self) -> Self {
        self.stream_request_bodies = true;
        self
    }

    /// A route for `App::default_service` or `App::route`.
    pub fn route(self) -> Route {
        web::to(move |request: HttpRequest, payload: web::Payload| {
            let service = self.clone();
            async move { service.handle(request, payload).await }
        })
    }

    /// Answer a request, with general error responses.
    pub async fn handle(&self, request: HttpRequest, payload: web::Payload) -> HttpResponse {
        match self.fetch(&request, payload).await {
            Ok(answer) => response(answer),
            Err(error) => {
                if let Some(callback) = &self.on_error {
                    callback(&error);
                }
                response(error.response())
            }
        }
    }

    /// Run the handler, returning detailed errors.
    pub async fn fetch(
        &self,
        request: &HttpRequest,
        payload: web::Payload,
    ) -> Result<http::Response<fetchlet::Body>, Error> {
        let mut head = request_head(request, &self.origin)?;
        let context = match &self.context {
            Some(context) => context(request)?,
            None => serde_json::to_value(RequestContext::new(
                request.peer_addr().map(|address| address.ip()),
            ))
            .map_err(Error::Context)?,
        };
        if let Some(trusted) = &self.trusted_context {
            head.extensions.insert(trusted(request));
        }

        let limit = self.app.limits().request_body_bytes;
        let (declared, has_body) = declared_body(&head);
        let body = if !has_body {
            fetchlet::Body::empty()
        } else if self.stream_request_bodies {
            // The invocation checks the declared length and the bytes it reads.
            fetchlet::Body::from_http_body(ForwardedBody::spawn(payload, declared))
        } else {
            if let (Some(limit), Some(declared)) = (limit, declared)
                && declared > limit as u64
            {
                return Err(fetchlet::Error::LimitExceeded("request body bytes").into());
            }
            fetchlet::Body::from(collect(payload, limit).await?)
        };
        let request = http::Request::from_parts(head, body);
        Ok(self.app.fetch_with_context(request, &context).await?)
    }
}

use std::fmt::Display;
use std::future::poll_fn;

use bytes::Bytes;
use http::header::{CONTENT_TYPE, HeaderValue};
use http::{Request, Response, StatusCode};
use http_body::Body;
use http_body_util::{BodyExt, Full, Limited};
use tower_service::Service;

/// Answers a webview's custom-protocol requests in-process with an HTTP
/// service, such as an axum `Router` or a [`FetchletService`](crate::FetchletService).
///
/// A custom URI scheme passes each request with its whole body and takes a
/// whole response, as Tauri's `UriSchemeResponder` does, so the responder
/// collects each response body. `response_body_bytes` bounds what it
/// collects: it is the caller's memory budget for one response, since the
/// body is held in full before the webview receives it. A larger response
/// becomes a `502 Bad Gateway`.
///
/// `services` makes the service for each request, so a host that replaces
/// its application, such as one using [`DevReload`](crate::DevReload)'s
/// `current`, answers each request with the build current when it arrives.
#[derive(Clone)]
pub struct WebviewResponder<F> {
    services: F,
    response_body_bytes: usize,
}

impl<F> WebviewResponder<F> {
    /// A responder that answers with the service `services` returns for each
    /// request, collecting at most `response_body_bytes` of each response.
    pub fn new(services: F, response_body_bytes: usize) -> Self {
        Self {
            services,
            response_body_bytes,
        }
    }

    /// The response to `request`, whose body the service receives as a
    /// `Full<Bytes>`. Errors of the service and of the response
    /// body are written to standard error and answered with a status.
    pub async fn respond<S, R>(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>>
    where
        F: Fn() -> S,
        S: Service<Request<Full<Bytes>>, Response = Response<R>>,
        S::Error: Display,
        R: Body,
        R::Error: Into<crate::BoxError>,
    {
        let mut service = (self.services)();
        let request = request.map(|body| Full::new(Bytes::from(body)));
        let response = match poll_fn(|context| service.poll_ready(context)).await {
            Ok(()) => service.call(request).await,
            Err(error) => Err(error),
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                eprintln!("fetchlet: webview request failed: {error}");
                return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
            }
        };
        let (parts, body) = response.into_parts();
        match Limited::new(body, self.response_body_bytes).collect().await {
            Ok(collected) => Response::from_parts(parts, collected.to_bytes().to_vec()),
            Err(error) => {
                eprintln!("fetchlet: webview response failed: {error}");
                text_response(StatusCode::BAD_GATEWAY, "Bad Gateway")
            }
        }
    }
}

fn text_response(status: StatusCode, body: &'static str) -> Response<Vec<u8>> {
    let mut response = Response::new(body.as_bytes().to_vec());
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

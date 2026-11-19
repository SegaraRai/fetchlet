use std::fmt;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::{Context, Poll};

use fetchlet::Body;
use http::{Method, Request, Response, StatusCode};
use http_body_util::Either;
use hyper::body::Incoming;
use tower_service::Service;

use super::ViteDev;

/// The response body of a [`ViteProxy`]: Vite's or the app's.
pub type ViteBody<B> = Either<Incoming, B>;

/// The Tower service of [`ViteDev::proxy`].
///
/// `GET` and `HEAD` requests go to the Vite dev server first, which answers
/// browser modules, its HMR client and public files; a 404 from Vite, a
/// request it cannot be reached for, and every other method go to the app.
/// Requests under `/@fetchlet/` other than the client entry stay with the
/// app, so the runner's endpoints are not reachable through the proxy.
#[derive(Clone)]
pub struct ViteProxy<S> {
    vite: ViteDev,
    app: S,
}

impl<S> fmt::Debug for ViteProxy<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ViteProxy")
            .field("vite", &self.vite)
            .finish_non_exhaustive()
    }
}

impl<S> ViteProxy<S> {
    pub(super) fn new(vite: ViteDev, app: S) -> Self {
        Self { vite, app }
    }
}

/// Whether Vite may answer a request for `path`.
fn vite_may_answer(method: &Method, path: &str) -> bool {
    (method == Method::GET || method == Method::HEAD)
        && (!path.starts_with("/@fetchlet/") || path == "/@fetchlet/client")
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ViteProxy<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
{
    type Response = Response<ViteBody<ResBody>>;

    type Error = S::Error;

    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Each request clones the app and waits for its readiness.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<ReqBody>) -> Self::Future {
        let vite = self.vite.clone();
        let mut app = self.app.clone();
        Box::pin(async move {
            if vite_may_answer(request.method(), request.uri().path()) {
                let mut forwarded = Request::new(Body::empty());
                *forwarded.method_mut() = request.method().clone();
                *forwarded.uri_mut() = vite.uri(request.uri().path_and_query());
                *forwarded.headers_mut() = request.headers().clone();
                forwarded
                    .headers_mut()
                    .insert(http::header::HOST, vite.host());
                if let Ok(response) = vite.client().request(forwarded).await
                    && response.status() != StatusCode::NOT_FOUND
                {
                    return Ok(response.map(Either::Left));
                }
            }
            poll_fn(|context| app.poll_ready(context)).await?;
            let response = app.call(request).await?;
            Ok(response.map(Either::Right))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_runner_endpoints_from_the_browser() {
        assert!(vite_may_answer(&Method::GET, "/src/client.ts"));
        assert!(vite_may_answer(&Method::HEAD, "/@vite/client"));
        assert!(vite_may_answer(&Method::GET, "/@fetchlet/client"));
        assert!(!vite_may_answer(
            &Method::GET,
            "/@fetchlet/artifact/server.js"
        ));
        assert!(!vite_may_answer(&Method::POST, "/@fetchlet/invoke"));
        assert!(!vite_may_answer(&Method::POST, "/api/echo"));
    }
}

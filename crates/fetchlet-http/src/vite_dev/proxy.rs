use std::fmt;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::{Context, Poll};

use fetchlet::Body;
use http::header::UPGRADE;
use http::{HeaderMap, Method, Request, Response, StatusCode};
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
/// So do WebSocket upgrades, which the app may accept: the browser opens
/// Vite's HMR socket on Vite's own port, and Vite would hold an upgrade it
/// does not serve without answering.
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
fn vite_may_answer(method: &Method, path: &str, headers: &HeaderMap) -> bool {
    (method == Method::GET || method == Method::HEAD)
        && (!path.starts_with("/@fetchlet/") || path == "/@fetchlet/client")
        && !headers.contains_key(UPGRADE)
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
            if vite_may_answer(request.method(), request.uri().path(), request.headers()) {
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
        let none = HeaderMap::new();
        assert!(vite_may_answer(&Method::GET, "/src/client.ts", &none));
        assert!(vite_may_answer(&Method::HEAD, "/@vite/client", &none));
        assert!(vite_may_answer(&Method::GET, "/@fetchlet/client", &none));
        assert!(!vite_may_answer(
            &Method::GET,
            "/@fetchlet/artifact/server.js",
            &none
        ));
        assert!(!vite_may_answer(&Method::POST, "/@fetchlet/invoke", &none));
        assert!(!vite_may_answer(&Method::POST, "/api/echo", &none));
    }

    #[test]
    fn leaves_upgrades_to_the_app() {
        let mut upgrade = HeaderMap::new();
        upgrade.insert(UPGRADE, http::HeaderValue::from_static("websocket"));
        assert!(!vite_may_answer(&Method::GET, "/api/socket", &upgrade));
    }
}

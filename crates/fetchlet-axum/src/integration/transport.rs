use std::convert::Infallible;
use std::future::poll_fn;

use axum::body::Body;
use axum::extract::Request;
use axum::response::Response;
use tower_service::Service;

use fetchlet::{FetchTransport, TransportFuture};

/// Serve host fetches with an axum `Router` or another Tower service.
///
/// The same router can serve public HTTP and in-process fetches from
/// JavaScript. Requests keep their method, absolute URI, headers, body and
/// extensions, so handlers read the trusted [`fetchlet::Context`] with
/// `Extension<fetchlet::Context>` when the route receives it (see
/// [`fetchlet::OriginRouter::internal`]). In-process requests carry no
/// `ConnectInfo`; extractors that need connection state should get it from
/// the Context. Response bodies stream back to JavaScript. Dropping the fetch
/// drops the handler future.
pub fn router_transport<S>(service: S) -> impl FetchTransport
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + Sync + 'static,
    S::Future: Send + 'static,
{
    RouterTransport { service }
}

struct RouterTransport<S> {
    service: S,
}

impl<S> FetchTransport for RouterTransport<S>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + Sync + 'static,
    S::Future: Send + 'static,
{
    fn send(&self, request: fetchlet::Request) -> TransportFuture {
        let mut service = self.service.clone();
        let request = request.map(Body::new);
        Box::pin(async move {
            let Ok(()) = poll_fn(|context| service.poll_ready(context)).await;
            let Ok(response) = service.call(request).await;
            Ok(response.map(fetchlet::Body::from_http_body))
        })
    }
}

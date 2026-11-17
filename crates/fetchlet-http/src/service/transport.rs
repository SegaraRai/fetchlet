use std::fmt;
use std::future::poll_fn;

use bytes::Bytes;
use http::Response;
use tower_service::Service;

use fetchlet::{FetchTransport, TransportFuture};

/// Serve host fetches with a Tower service, such as an axum `Router`.
///
/// The same service can serve public HTTP and in-process fetches from
/// JavaScript. Requests keep their method, absolute URI, headers, body and
/// extensions, so handlers read the trusted [`fetchlet::Context`] from the
/// extensions when the route receives it (see
/// [`fetchlet::OriginRouter::internal`]). In-process requests carry no
/// connection data; handlers that need it should get it from the Context.
/// Response bodies stream back to JavaScript. Dropping the fetch drops the
/// service future. A service error rejects the fetch with a general transport
/// error; its detail stays in Rust.
pub fn service_transport<S, B>(service: S) -> impl FetchTransport
where
    S: Service<http::Request<fetchlet::Body>, Response = Response<B>>
        + Clone
        + Send
        + Sync
        + 'static,
    S::Error: fmt::Display,
    S::Future: Send + 'static,
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: fmt::Display,
{
    ServiceTransport { service }
}

struct ServiceTransport<S> {
    service: S,
}

impl<S, B> FetchTransport for ServiceTransport<S>
where
    S: Service<http::Request<fetchlet::Body>, Response = Response<B>>
        + Clone
        + Send
        + Sync
        + 'static,
    S::Error: fmt::Display,
    S::Future: Send + 'static,
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: fmt::Display,
{
    fn send(&self, request: fetchlet::Request) -> TransportFuture {
        let mut service = self.service.clone();
        Box::pin(async move {
            let failed = |error: S::Error| fetchlet::Error::Transport(error.to_string());
            poll_fn(|context| service.poll_ready(context))
                .await
                .map_err(failed)?;
            let response = service.call(request).await.map_err(failed)?;
            Ok(response.map(fetchlet::Body::from_http_body))
        })
    }
}

//! The shared HTTP integration contract for the Tower service.

mod contract;

use std::net::SocketAddr;

use http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

use fetchlet::AppHandle;
use fetchlet_http::FetchletService;

use contract::{ClientBody, Exchange, Options, Payload, Reply, Target};

struct Tower;

impl Target for Tower {
    type Server = FetchletService;

    fn build(
        &self,
        app: AppHandle,
        public_origin: &str,
        options: &Options,
    ) -> Result<FetchletService, String> {
        let errors = options.errors.clone();
        let mut service = FetchletService::new(app, public_origin)
            .map_err(|error| error.to_string())?
            // The test client records the peer in the request extensions.
            .client_address(|parts| parts.extensions.get::<SocketAddr>().map(SocketAddr::ip))
            .on_error(move |error| errors.lock().unwrap().push(error.to_string()));
        if options.stream_request_bodies {
            service = service.stream_request_bodies();
        }
        if options.tenant_context {
            service = service.context(|parts| {
                contract::tenant_context(
                    parts
                        .headers
                        .get("x-tenant")
                        .and_then(|value| value.to_str().ok()),
                )
            });
        }
        if options.trusted_caller {
            service = service.trusted_context(|parts| {
                contract::caller_context(parts.extensions.get::<SocketAddr>().map(SocketAddr::ip))
            });
        }
        Ok(service)
    }

    async fn send(&self, server: &FetchletService, exchange: Exchange) -> Reply {
        let declared = match &exchange.body {
            Payload::Full(data) => Some(data.len()),
            _ => None,
        };
        let mut request = Request::builder()
            .method(exchange.method)
            .uri(exchange.target);
        for (name, value) in exchange.headers {
            request = request.header(name, value);
        }
        if let Some(length) = declared {
            request = request.header("content-length", length);
        }
        let mut request = request.body(ClientBody::new(exchange.body)).unwrap();
        if let Some(peer) = exchange.peer {
            request.extensions_mut().insert(peer);
        }
        let response = server.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let body = BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        Reply {
            status,
            headers,
            body: body.to_vec(),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn request_parts() {
    contract::request_parts(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn custom_context() {
    contract::custom_context(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn collected_bodies() {
    contract::collected_bodies(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn streamed_bodies() {
    contract::streamed_bodies(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn error_details() {
    contract::error_details(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn trusted_context() {
    contract::trusted_context(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn origin_validation() {
    contract::origin_validation(&Tower).await;
}

#[tokio::test(flavor = "current_thread")]
async fn disconnect_cancels() {
    contract::disconnect_cancels(&Tower).await;
}

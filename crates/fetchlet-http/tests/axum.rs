//! The shared HTTP integration contract for the axum service.

mod contract;

use std::net::SocketAddr;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::Request;
use tower::ServiceExt;

use fetchlet::AppHandle;
use fetchlet_http::{AxumService, connect_info};

use contract::{ClientBody, Exchange, Options, Payload, Reply, Target};

struct Axum;

impl Target for Axum {
    type Server = AxumService;

    fn build(
        &self,
        app: AppHandle,
        public_origin: &str,
        options: &Options,
    ) -> Result<AxumService, String> {
        let errors = options.errors.clone();
        // The default context reads ConnectInfo.
        let mut service = AxumService::new(app, public_origin)
            .map_err(|error| error.to_string())?
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
            service =
                service.trusted_context(|parts| contract::caller_context(connect_info(parts)));
        }
        Ok(service)
    }

    async fn send(&self, server: &AxumService, exchange: Exchange) -> Reply {
        let mut request = Request::builder()
            .method(exchange.method)
            .uri(exchange.target);
        for (name, value) in exchange.headers {
            request = request.header(name, value);
        }
        if let Payload::Full(data) = &exchange.body {
            request = request.header("content-length", data.len());
        }
        let mut request = request
            .body(Body::new(ClientBody::new(exchange.body)))
            .unwrap();
        if let Some(peer) = exchange.peer {
            request
                .extensions_mut()
                .insert(ConnectInfo::<SocketAddr>(peer));
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
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            headers,
            body: body.to_vec(),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn request_parts() {
    contract::request_parts(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn custom_context() {
    contract::custom_context(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn collected_bodies() {
    contract::collected_bodies(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn streamed_bodies() {
    contract::streamed_bodies(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn error_details() {
    contract::error_details(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn trusted_context() {
    contract::trusted_context(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn origin_validation() {
    contract::origin_validation(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn disconnect_cancels() {
    contract::disconnect_cancels(&Axum).await;
}

#[tokio::test(flavor = "current_thread")]
async fn disconnect_aborts_the_request_signal() {
    contract::disconnect_aborts_the_request_signal(&Axum).await;
}

#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! The shared HTTP integration contract for the actix-web handler.

#[path = "../../../tests/http-integrations/contract.rs"]
mod contract;

use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};

use actix_web::dev::Payload as ActixPayload;
use actix_web::error::PayloadError;
use actix_web::http::Method;
use actix_web::{App, test};
use bytes::Bytes;
use futures_core::Stream;

use contract::{Exchange, Options, Payload, Reply, Target};
use fetchlet::AppHandle;
use fetchlet_actix::FetchletService;

/// A client payload that arrives in chunks, or fails.
struct ClientStream {
    chunks: VecDeque<Bytes>,
    broken: bool,
}

impl Stream for ClientStream {
    type Item = Result<Bytes, PayloadError>;

    fn poll_next(mut self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.broken {
            self.broken = false;
            return Poll::Ready(Some(Err(PayloadError::Incomplete(None))));
        }
        Poll::Ready(self.chunks.pop_front().map(Ok))
    }
}

struct Actix;

impl Target for Actix {
    type Server = FetchletService;

    fn build(
        &self,
        app: AppHandle,
        public_origin: &str,
        options: &Options,
    ) -> Result<FetchletService, String> {
        let errors = options.errors.clone();
        // The default context reads the peer address.
        let mut service = FetchletService::new(app, public_origin)
            .map_err(|error| error.to_string())?
            .on_error(move |error| errors.lock().unwrap().push(error.to_string()));
        if options.stream_request_bodies {
            service = service.stream_request_bodies();
        }
        if options.tenant_context {
            service = service.context(|request| {
                contract::tenant_context(
                    request
                        .headers()
                        .get("x-tenant")
                        .and_then(|value| value.to_str().ok()),
                )
            });
        }
        if options.trusted_caller {
            service = service.trusted_context(|request| {
                contract::caller_context(request.peer_addr().map(|address| address.ip()))
            });
        }
        Ok(service)
    }

    async fn send(&self, server: &FetchletService, exchange: Exchange) -> Reply {
        let app = test::init_service(App::new().default_service(server.clone().route())).await;
        let mut request = test::TestRequest::default()
            .method(Method::from_bytes(exchange.method.as_bytes()).unwrap())
            .uri(exchange.target);
        for (name, value) in exchange.headers {
            request = request.insert_header((name, value));
        }
        if let Some(peer) = exchange.peer {
            request = request.peer_addr(peer);
        }
        let stream = |chunks: Vec<Vec<u8>>, broken| ClientStream {
            chunks: chunks.into_iter().map(Bytes::from).collect(),
            broken,
        };
        let request = match exchange.body {
            Payload::Empty => request.to_request(),
            Payload::Full(data) => request.set_payload(data).to_request(),
            Payload::Chunks(chunks) => streamed(request, stream(chunks, false)),
            Payload::Broken => streamed(request, stream(Vec::new(), true)),
        };
        let response = test::call_service(&app, request).await;
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
        let body = test::read_body(response).await;
        Reply {
            status,
            headers,
            body: body.to_vec(),
        }
    }
}

/// A chunked request whose payload is `stream`.
fn streamed(request: test::TestRequest, stream: ClientStream) -> actix_http::Request {
    let request = request
        .insert_header(("transfer-encoding", "chunked"))
        .to_request();
    let payload: Pin<Box<dyn Stream<Item = Result<Bytes, PayloadError>>>> = Box::pin(stream);
    request.replace_payload(ActixPayload::from(payload)).0
}

#[actix_web::test]
async fn request_parts() {
    contract::request_parts(&Actix).await;
}

#[actix_web::test]
async fn custom_context() {
    contract::custom_context(&Actix).await;
}

#[actix_web::test]
async fn collected_bodies() {
    contract::collected_bodies(&Actix).await;
}

#[actix_web::test]
async fn streamed_bodies() {
    contract::streamed_bodies(&Actix).await;
}

#[actix_web::test]
async fn error_details() {
    contract::error_details(&Actix).await;
}

#[actix_web::test]
async fn trusted_context() {
    contract::trusted_context(&Actix).await;
}

#[actix_web::test]
async fn origin_validation() {
    contract::origin_validation(&Actix).await;
}

#[actix_web::test]
async fn disconnect_cancels() {
    contract::disconnect_cancels(&Actix).await;
}

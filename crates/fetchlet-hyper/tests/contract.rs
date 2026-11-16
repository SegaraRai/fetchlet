#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! The shared HTTP integration contract over real hyper connections.

#[path = "../../../tests/http-integrations/contract.rs"]
mod contract;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use http::Request;
use http_body_util::BodyExt;
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use contract::{ClientBody, Exchange, Options, Reply, Target};
use fetchlet::AppHandle;
use fetchlet_hyper::FetchletService;

/// A hyper server on a loopback port, one connection per exchange.
struct Server {
    address: SocketAddr,
    /// The peer address the next accepted connection reports, as a proxy or
    /// the operating system would; loopback otherwise.
    next_peer: Arc<Mutex<Option<SocketAddr>>>,
    accept: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Hyper;

impl Target for Hyper {
    type Server = Server;

    fn build(
        &self,
        app: AppHandle,
        public_origin: &str,
        options: &Options,
    ) -> Result<Server, String> {
        let errors = options.errors.clone();
        let mut service = FetchletService::new(app, public_origin)
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
            service = service.trusted_context(|parts| {
                contract::caller_context(fetchlet_hyper::peer_addr(parts))
            });
        }

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let listener = TcpListener::from_std(listener).unwrap();
        let next_peer = Arc::new(Mutex::new(None));
        let peers = next_peer.clone();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let io = TokioIo::new(stream);
                let peer = peers.lock().unwrap().take();
                match peer {
                    Some(peer) => {
                        let connection = service.connection(peer);
                        tokio::spawn(http1::Builder::new().serve_connection(io, connection));
                    }
                    None => {
                        let service = service.clone();
                        tokio::spawn(http1::Builder::new().serve_connection(io, service));
                    }
                }
            }
        });
        Ok(Server {
            address,
            next_peer,
            accept,
        })
    }

    async fn send(&self, server: &Server, exchange: Exchange) -> Reply {
        *server.next_peer.lock().unwrap() = exchange.peer;
        let stream = TcpStream::connect(server.address).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        // Dropping the exchange closes the connection, as a client that gives up does.
        let _connection = AbortOnDrop(tokio::spawn(connection));

        let mut request = Request::builder()
            .method(exchange.method)
            .uri(exchange.target);
        if !exchange.headers.iter().any(|(name, _)| *name == "host") {
            request = request.header("host", "loopback.test");
        }
        for (name, value) in exchange.headers {
            request = request.header(name, value);
        }
        // hyper declares Content-Length from the body's exact size, and
        // sends other bodies chunked.
        let request = request.body(ClientBody::new(exchange.body)).unwrap();
        let Ok(response) = sender.send_request(request).await else {
            // The body failed and the client aborted the connection.
            return Reply {
                status: 0,
                headers: Vec::new(),
                body: Vec::new(),
            };
        };
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
        let body = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: body.to_vec(),
        }
    }

    fn replies_to_failed_bodies(&self) -> bool {
        false
    }
}

#[tokio::test(flavor = "current_thread")]
async fn request_parts() {
    contract::request_parts(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn custom_context() {
    contract::custom_context(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn collected_bodies() {
    contract::collected_bodies(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn streamed_bodies() {
    contract::streamed_bodies(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn error_details() {
    contract::error_details(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn trusted_context() {
    contract::trusted_context(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn origin_validation() {
    contract::origin_validation(&Hyper).await;
}

#[tokio::test(flavor = "current_thread")]
async fn disconnect_cancels() {
    contract::disconnect_cancels(&Hyper).await;
}

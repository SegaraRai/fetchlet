//! The shared contract of fetchlet's Rust HTTP integrations.
//!
//! Each integration crate includes this module from its tests with
//! `#[path = "../../../tests/http-integrations/contract.rs"]`, implements
//! [`Target`] for its service, and runs every check. The checks drive the
//! integration with requests of its own server framework, so the same
//! expectations hold for Tower, axum and actix-web.

#![allow(dead_code)]

use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body::{Frame, SizeHint};

use fetchlet::{
    App, AppHandle, Backend, Body, Context, HostServices, Limits, Module, OriginRouter, Response,
    WorkerOptions, transport_fn,
};

const SOURCE: &str = include_str!("handler.js");

/// The request body budget of the contract's application, in bytes.
pub const BODY_BUDGET: usize = 32;

pub const PUBLIC_ORIGIN: &str = "https://public.test:8443";

pub fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::Boa,
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

/// A request body as the client sends it.
pub enum Payload {
    Empty,
    /// One chunk with a declared `Content-Length`.
    Full(Vec<u8>),
    /// Separate chunks without a declared length.
    Chunks(Vec<Vec<u8>>),
    /// A body that fails while it is read.
    Broken,
}

/// A client body for each contract payload.
pub struct ClientBody {
    chunks: Vec<Bytes>,
    declared: Option<u64>,
    broken: bool,
}

impl ClientBody {
    pub fn new(payload: Payload) -> Self {
        match payload {
            Payload::Empty => Self::chunks(Vec::new(), Some(0)),
            Payload::Full(data) => {
                let declared = Some(data.len() as u64);
                Self::chunks(vec![data], declared)
            }
            Payload::Chunks(chunks) => Self::chunks(chunks, None),
            Payload::Broken => Self {
                chunks: Vec::new(),
                declared: None,
                broken: true,
            },
        }
    }

    fn chunks(chunks: Vec<Vec<u8>>, declared: Option<u64>) -> Self {
        Self {
            chunks: chunks.into_iter().map(Bytes::from).collect(),
            declared,
            broken: false,
        }
    }
}

impl http_body::Body for ClientBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if self.broken {
            return Poll::Ready(Some(Err(std::io::Error::other("connection interrupted"))));
        }
        let next = (!self.chunks.is_empty()).then(|| Ok(Frame::data(self.chunks.remove(0))));
        Poll::Ready(next)
    }

    fn is_end_stream(&self) -> bool {
        !self.broken && self.chunks.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        self.declared
            .map_or_else(SizeHint::default, SizeHint::with_exact)
    }
}

/// A request to the integration, in framework-neutral terms.
pub struct Exchange {
    pub method: &'static str,
    /// A path and query, or an absolute URL whose authority clients chose.
    pub target: &'static str,
    pub headers: Vec<(&'static str, &'static str)>,
    pub body: Payload,
    pub peer: Option<SocketAddr>,
}

impl Exchange {
    pub fn get(target: &'static str) -> Self {
        Self {
            method: "GET",
            target,
            headers: Vec::new(),
            body: Payload::Empty,
            peer: None,
        }
    }

    pub fn post(target: &'static str, body: Payload) -> Self {
        Self {
            method: "POST",
            body,
            ..Self::get(target)
        }
    }
}

/// The response the client receives.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn count(&self, name: &str) -> usize {
        self.headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .count()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Detailed errors observed by the integration's error callback.
pub type Errors = Arc<Mutex<Vec<String>>>;

/// Integration settings that each check selects.
#[derive(Clone, Default)]
pub struct Options {
    pub stream_request_bodies: bool,
    /// Replace the default context with [`tenant_context`] of the
    /// `x-tenant` request header.
    pub tenant_context: bool,
    /// Derive the trusted Context with [`caller_context`] of the peer address.
    pub trusted_caller: bool,
    pub errors: Errors,
}

/// The JavaScript context the tenant option supplies.
pub fn tenant_context(tenant: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "tenant": tenant })
}

/// The trusted caller, chosen by the Rust host.
#[derive(Clone)]
pub struct Caller(pub String);

/// The trusted Context the caller option supplies.
pub fn caller_context(address: Option<IpAddr>) -> Context {
    let address = address.map_or_else(|| "unknown".to_owned(), |address| address.to_string());
    Context::new().with(Caller(address))
}

/// An integration under test.
#[allow(async_fn_in_trait)]
pub trait Target {
    type Server;

    fn build(
        &self,
        app: AppHandle,
        public_origin: &str,
        options: &Options,
    ) -> Result<Self::Server, String>;

    async fn send(&self, server: &Self::Server, exchange: Exchange) -> Reply;

    /// Whether the client receives a response after its request body failed.
    ///
    /// In-process test clients do. Over a real HTTP/1.1 connection the client
    /// aborts the connection when its body fails, so only the server side and
    /// the following request can be checked; `send` then returns status 0.
    fn replies_to_failed_bodies(&self) -> bool {
        true
    }
}

/// Check the status of a reply to a failed request body, where observable.
fn assert_failed_body<T: Target>(target: &T, reply: &Reply, status: u16) {
    if target.replies_to_failed_bodies() {
        assert_eq!(reply.status, status);
    } else {
        assert_eq!(reply.status, 0, "the connection was aborted");
    }
}

/// In-process requests to `/slow` that were dropped before answering.
static DROPPED_SLOW_CALLS: AtomicUsize = AtomicUsize::new(0);

struct DropRecorder;

impl Drop for DropRecorder {
    fn drop(&mut self) {
        DROPPED_SLOW_CALLS.fetch_add(1, Ordering::SeqCst);
    }
}

fn caller_response(request: &fetchlet::Request) -> Response {
    let caller = Context::of(request)
        .and_then(|context| context.get::<Caller>())
        .map_or("anonymous", |Caller(address)| address.as_str());
    Response::new(Body::from(caller.to_owned()))
}

pub async fn spawn(backend: Backend) -> AppHandle {
    let api = OriginRouter::new()
        .internal(
            "https://api.test",
            transport_fn(|request| {
                let slow = request.uri().path() == "/slow";
                let response = caller_response(&request);
                async move {
                    if slow {
                        let _recorder = DropRecorder;
                        std::future::pending::<()>().await;
                    }
                    Ok(response)
                }
            }),
        )
        .unwrap()
        .into_service();
    App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().outbound(api))
        .limits(Limits {
            request_body_bytes: Some(BODY_BUDGET),
            ..Limits::default()
        })
        .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
        .await
        .unwrap()
}

async fn start<T: Target>(
    target: &T,
    backend: Backend,
    options: Options,
) -> (AppHandle, T::Server) {
    let app = spawn(backend).await;
    let server = target.build(app.clone(), PUBLIC_ORIGIN, &options).unwrap();
    (app, server)
}

fn peer() -> Option<SocketAddr> {
    Some("192.0.2.4:1234".parse().unwrap())
}

/// The public origin replaces the client's authority; method, headers,
/// binary bodies, repeated Set-Cookie and the client address are kept.
pub async fn request_parts<T: Target>(target: &T) {
    for backend in backends() {
        let (app, server) = start(target, backend, Options::default()).await;
        let reply = target
            .send(
                &server,
                Exchange {
                    method: "POST",
                    target: "http://untrusted.test/echo?value=1",
                    headers: vec![("host", "untrusted.test"), ("x-test", "kept")],
                    body: Payload::Full(vec![0, 128, 255]),
                    peer: peer(),
                },
            )
            .await;
        assert_eq!(reply.status, 201);
        assert_eq!(
            reply.header("x-url"),
            Some("https://public.test:8443/echo?value=1")
        );
        assert_eq!(reply.header("x-method"), Some("POST"));
        assert_eq!(reply.header("x-request-header"), Some("kept"));
        assert_eq!(reply.header("x-address"), Some("192.0.2.4"));
        assert_eq!(reply.count("set-cookie"), 2);
        assert_eq!(reply.body, [0, 128, 255]);

        let reply = target.send(&server, Exchange::get("/")).await;
        assert_eq!(reply.header("x-url"), Some("https://public.test:8443/"));
        assert_eq!(reply.header("x-address"), Some("none"));
        app.shutdown().await.unwrap();
    }
}

/// An application context replaces the default one.
pub async fn custom_context<T: Target>(target: &T) {
    for backend in backends() {
        let options = Options {
            tenant_context: true,
            ..Options::default()
        };
        let (app, server) = start(target, backend, options).await;
        let reply = target
            .send(
                &server,
                Exchange {
                    headers: vec![("x-tenant", "example")],
                    peer: peer(),
                    ..Exchange::get("/context")
                },
            )
            .await;
        assert_eq!(reply.header("x-tenant"), Some("example"));
        assert_eq!(reply.header("x-address"), Some("none"));
        app.shutdown().await.unwrap();
    }
}

/// Collected bodies are classified before execution: excess is 413 and a
/// failing body is 400. The following request is served.
pub async fn collected_bodies<T: Target>(target: &T) {
    for backend in backends() {
        let (app, server) = start(target, backend, Options::default()).await;
        let full = Exchange::post("/count", Payload::Full(vec![7; BODY_BUDGET]));
        assert_eq!(target.send(&server, full).await.text(), "1:32");
        for (payload, status) in [
            (Payload::Full(vec![0; BODY_BUDGET + 1]), 413),
            (Payload::Chunks(vec![vec![0; 20], vec![0; 20]]), 413),
        ] {
            let reply = target
                .send(&server, Exchange::post("/count", payload))
                .await;
            assert_eq!(reply.status, status);
        }
        let reply = target
            .send(&server, Exchange::post("/count", Payload::Broken))
            .await;
        assert_failed_body(target, &reply, 400);
        assert_eq!(
            target
                .send(&server, Exchange::get("/following"))
                .await
                .status,
            201
        );
        app.shutdown().await.unwrap();
    }
}

/// Streamed bodies reach the handler in chunks. A declared excess is 413
/// before execution; undeclared excess and failures error the handler's
/// stream, and the handler decides the status.
pub async fn streamed_bodies<T: Target>(target: &T) {
    for backend in backends() {
        let options = Options {
            stream_request_bodies: true,
            ..Options::default()
        };
        let (app, server) = start(target, backend, options).await;
        let chunked = Payload::Chunks(vec![vec![7; 10], vec![7; 12]]);
        let reply = target
            .send(&server, Exchange::post("/count", chunked))
            .await;
        assert_eq!((reply.status, reply.text()), (200, "2:22".into()));
        for (payload, status, text) in [
            (Payload::Full(vec![0; BODY_BUDGET + 1]), 413, None),
            (
                Payload::Chunks(vec![vec![0; 20], vec![0; 20]]),
                422,
                Some("LIMIT_EXCEEDED"),
            ),
        ] {
            let reply = target
                .send(&server, Exchange::post("/count", payload))
                .await;
            assert_eq!(reply.status, status);
            if let Some(text) = text {
                assert_eq!(reply.text(), text);
            }
        }
        let reply = target
            .send(&server, Exchange::post("/count", Payload::Broken))
            .await;
        assert_failed_body(target, &reply, 422);
        if target.replies_to_failed_bodies() {
            assert_eq!(reply.text(), "TRANSPORT");
        }
        assert_eq!(
            target
                .send(&server, Exchange::get("/following"))
                .await
                .status,
            201
        );
        app.shutdown().await.unwrap();
    }
}

/// Failures answer with general messages; details reach the error callback.
pub async fn error_details<T: Target>(target: &T) {
    for backend in backends() {
        let options = Options::default();
        let errors = options.errors.clone();
        let (app, server) = start(target, backend, options).await;
        let reply = target.send(&server, Exchange::get("/failure")).await;
        assert_eq!(reply.status, 500);
        assert_eq!(reply.text(), "Internal Server Error");
        {
            let errors = errors.lock().unwrap();
            assert_eq!(errors.len(), 1);
            assert!(errors[0].contains("provider-private-detail"));
        }

        app.shutdown().await.unwrap();
        let reply = target.send(&server, Exchange::get("/closed")).await;
        assert_eq!(reply.status, 503);
    }
}

/// The trusted Context comes from the integration's Rust callback, not from
/// headers, and reaches in-process routes.
pub async fn trusted_context<T: Target>(target: &T) {
    for backend in backends() {
        let options = Options {
            trusted_caller: true,
            ..Options::default()
        };
        let (app, server) = start(target, backend, options).await;
        let reply = target
            .send(
                &server,
                Exchange {
                    headers: vec![("x-caller", "forged")],
                    peer: peer(),
                    ..Exchange::get("/caller")
                },
            )
            .await;
        assert_eq!((reply.status, reply.text()), (200, "192.0.2.4".into()));
        app.shutdown().await.unwrap();

        let (app, server) = start(target, backend, Options::default()).await;
        let reply = target.send(&server, Exchange::get("/caller")).await;
        assert_eq!(reply.text(), "anonymous");
        app.shutdown().await.unwrap();
    }
}

/// A client that stops waiting, for example by disconnecting, cancels the
/// invocation and its host fetches; the worker serves the next request.
pub async fn disconnect_cancels<T: Target>(target: &T) {
    for backend in backends() {
        let (app, server) = start(target, backend, Options::default()).await;
        let dropped = DROPPED_SLOW_CALLS.load(Ordering::SeqCst);
        let waiting = target.send(&server, Exchange::get("/slow"));
        assert!(
            tokio::time::timeout(Duration::from_millis(200), waiting)
                .await
                .is_err()
        );
        let following = target.send(&server, Exchange::get("/following"));
        let reply = tokio::time::timeout(Duration::from_secs(5), following)
            .await
            .expect("the worker is free again");
        assert_eq!(reply.status, 201);
        assert_eq!(DROPPED_SLOW_CALLS.load(Ordering::SeqCst), dropped + 1);
        app.shutdown().await.unwrap();
    }
}

/// Public origins are bare HTTP(S) origins.
pub async fn origin_validation<T: Target>(target: &T) {
    for backend in backends() {
        let app = spawn(backend).await;
        for invalid in [
            "example.test",
            "https://user:password@example.test",
            "https://example.test/path",
            "https://example.test?query=1",
            "https://example.test#fragment",
            "file://example.test",
        ] {
            assert!(
                target
                    .build(app.clone(), invalid, &Options::default())
                    .is_err(),
                "{invalid}"
            );
        }
        app.shutdown().await.unwrap();
    }
}

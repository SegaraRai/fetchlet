//! HttpClient: JavaScript's outbound fetch reaches HTTP servers, within the
//! address checks of the transport and the policy of its service.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body::{Body as _, Frame};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use fetchlet::http::{Method, Request, Response, StatusCode, header};
use fetchlet::{
    App, Backend, Body, Error, FetchPolicy, FetchService, FetchTransport, HostServices, Limits,
    Module,
};
use fetchlet_net::HttpClient;
use fetchlet_net::rustls::{self, ClientConfig, RootCertStore, ServerConfig};

const SOURCE: &str = include_str!("fixtures/http.js");

fn backends() -> Vec<Backend> {
    vec![Backend::quickjs(), Backend::boa(), Backend::v8()]
}

/// A response body that sends one chunk and then waits for the next, which
/// never comes while the test runs.
struct Unfinished(mpsc::Receiver<Bytes>);

impl http_body::Body for Unfinished {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(context)
            .map(|chunk| chunk.map(|chunk| Ok(Frame::data(chunk))))
    }
}

type ServerBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;

/// The text the coded routes send.
fn sample() -> Vec<u8> {
    (0..50_000u32)
        .flat_map(|n| format!("line {n}\n").into_bytes())
        .collect()
}

/// `data` in `coding`: `deflate` as zlib, `deflate-raw` as raw deflate.
fn encode(coding: &str, data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    match coding {
        "gzip" => {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(data).unwrap();
            encoder.finish().unwrap()
        }
        "deflate" => {
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(data).unwrap();
            encoder.finish().unwrap()
        }
        "deflate-raw" => {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(data).unwrap();
            encoder.finish().unwrap()
        }
        "br" => {
            let mut output = Vec::new();
            let mut encoder = brotli::CompressorWriter::new(&mut output, 4096, 5, 22);
            encoder.write_all(data).unwrap();
            drop(encoder);
            output
        }
        other => panic!("no coding {other}"),
    }
}

/// `/coded?<codings>&<label>` sends `sample()` in the comma-separated
/// codings, applied in order, labelled `<label>` in `Content-Encoding`, and
/// reports the request's `Accept-Encoding` as `x-accept`. `/zeros` sends
/// 16 MiB of zeros in gzip; `/corrupt` sends bytes that are not gzip.
fn coded(request: &Request<Incoming>) -> Response<ServerBody> {
    let accept = request
        .headers()
        .get(header::ACCEPT_ENCODING)
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let (body, label) = match request.uri().path() {
        "/zeros" => (encode("gzip", &vec![0; 16 << 20]), "gzip".to_owned()),
        "/corrupt" => (b"not gzip at all".to_vec(), "gzip".to_owned()),
        _ => {
            let query = request
                .uri()
                .query()
                .unwrap_or_default()
                .replace("%20", " ");
            let (codings, label) = query.split_once('&').unwrap();
            let body = codings
                .split(',')
                .fold(sample(), |data, coding| encode(coding, &data));
            (body, label.to_owned())
        }
    };
    Response::builder()
        .header(header::CONTENT_ENCODING, label)
        .header(header::CONTENT_LENGTH, body.len())
        .header("x-accept", accept)
        .body(Full::new(Bytes::from(body)).boxed())
        .unwrap()
}

/// `/echo` answers with the method, version, `x-test` header and body it
/// received, and echoes `x-test` as `x-echo`; `/redirect` answers 302;
/// `/stream` sends one chunk and keeps the body open.
async fn answer(request: Request<Incoming>) -> Result<Response<ServerBody>, Infallible> {
    match request.uri().path() {
        "/coded" | "/zeros" | "/corrupt" => Ok(coded(&request)),
        "/redirect" => Ok(Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, "/echo")
            .body(Full::new(Bytes::new()).boxed())
            .unwrap()),
        "/stream" => {
            let (sender, receiver) = mpsc::channel(1);
            sender.send(Bytes::from_static(b"first")).await.unwrap();
            // Keep the body open after its first chunk.
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                drop(sender);
            });
            Ok(Response::new(Unfinished(receiver).boxed()))
        }
        _ => {
            let method = request.method().clone();
            let version = request.version();
            let test = request
                .headers()
                .get("x-test")
                .map(|value| value.to_str().unwrap().to_owned())
                .unwrap_or_default();
            let body = request.into_body().collect().await.unwrap().to_bytes();
            let text = format!(
                "{method} {version:?} x-test={test} body={}",
                String::from_utf8_lossy(&body)
            );
            Ok(Response::builder()
                .header("x-echo", test)
                .body(Full::new(Bytes::from(text)).boxed())
                .unwrap())
        }
    }
}

/// A plain HTTP/1.1 server on a loopback port, counting its connections.
async fn server() -> anyhow::Result<(u16, Arc<AtomicUsize>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let connections = Arc::new(AtomicUsize::new(0));
    let counted = connections.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            counted.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let _ = auto::Builder::new(TokioExecutor::new())
                    .serve_connection(TokioIo::new(stream), service_fn(answer))
                    .await;
            });
        }
    });
    Ok((port, connections))
}

/// A TLS server that offers HTTP/2 and HTTP/1.1 by ALPN.
async fn tls_server() -> anyhow::Result<u16> {
    let certificate = CertificateDer::from(include_bytes!("fixtures/tls/server.der").to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        include_bytes!("fixtures/tls/server.key.der").to_vec(),
    ));
    let mut config = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key)?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(stream) = acceptor.accept(stream).await else {
                    return;
                };
                let _ = auto::Builder::new(TokioExecutor::new())
                    .serve_connection(TokioIo::new(stream), service_fn(answer))
                    .await;
            });
        }
    });
    Ok(port)
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A client that trusts the test certificate authority and reaches loopback.
fn trusting_client() -> anyhow::Result<HttpClient> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(
        include_bytes!("fixtures/tls/ca.der").to_vec(),
    ))?;
    let config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(HttpClient::with_tls_config(Arc::new(config)).allow_private_addresses())
}

fn request(method: Method, url: &str, body: &'static str) -> fetchlet::Request {
    Request::builder()
        .method(method)
        .uri(url)
        .header("x-test", "1")
        .body(Body::from(body))
        .unwrap()
}

async fn text(response: fetchlet::Response) -> anyhow::Result<String> {
    let body = response.into_body().collect(1 << 20).await?;
    Ok(String::from_utf8(body.to_vec())?)
}

#[tokio::test]
async fn a_request_reaches_an_http_server_and_back() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    let url = format!("http://127.0.0.1:{port}/echo");
    let response = client.send(request(Method::POST, &url, "hello")).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-echo"], "1");
    assert_eq!(text(response).await?, "POST HTTP/1.1 x-test=1 body=hello");
    Ok(())
}

#[tokio::test]
async fn https_verifies_the_server_and_negotiates_http2() -> anyhow::Result<()> {
    let port = tls_server().await?;
    let client = trusting_client()?;
    for host in ["localhost", "127.0.0.1"] {
        let url = format!("https://{host}:{port}/echo");
        let response = client.send(request(Method::PUT, &url, "secure")).await?;
        assert_eq!(text(response).await?, "PUT HTTP/2.0 x-test=1 body=secure");
    }
    // The default roots do not trust the test authority.
    let untrusting = HttpClient::new().allow_private_addresses();
    let url = format!("https://localhost:{port}/echo");
    let error = untrusting
        .send(request(Method::GET, &url, ""))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Transport(_)), "{error}");
    Ok(())
}

#[tokio::test]
async fn redirects_return_to_the_caller() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    let url = format!("http://127.0.0.1:{port}/redirect");
    let response = client.send(request(Method::GET, &url, "")).await?;
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(response.headers()[header::LOCATION], "/echo");
    Ok(())
}

#[tokio::test]
async fn response_bodies_stream_as_they_arrive() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    let url = format!("http://127.0.0.1:{port}/stream");
    let response = client.send(request(Method::GET, &url, "")).await?;
    let mut body = response.into_body();
    let frame = tokio::time::timeout(Duration::from_secs(10), body.frame())
        .await?
        .expect("a frame")?;
    assert_eq!(frame.into_data().ok(), Some(Bytes::from_static(b"first")));
    assert!(!body.is_end_stream());
    Ok(())
}

#[tokio::test]
async fn connections_to_one_origin_are_reused() -> anyhow::Result<()> {
    let (port, connections) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    let url = format!("http://127.0.0.1:{port}/echo");
    for _ in 0..3 {
        let response = client.send(request(Method::GET, &url, "")).await?;
        text(response).await?;
    }
    assert_eq!(connections.load(Ordering::SeqCst), 1);
    Ok(())
}

async fn coded_response(
    client: &HttpClient,
    port: u16,
    path: &str,
    accept: Option<&'static str>,
) -> anyhow::Result<fetchlet::Response> {
    let url = format!("http://127.0.0.1:{port}{}", path.replace(' ', "%20"));
    let mut request = request(Method::GET, &url, "");
    if let Some(accept) = accept {
        request
            .headers_mut()
            .insert(header::ACCEPT_ENCODING, accept.parse()?);
    }
    Ok(client.send(request).await?)
}

#[tokio::test]
async fn content_codings_are_undone() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    for (codings, label) in [
        ("gzip", "gzip"),
        ("gzip", "x-gzip"),
        ("deflate", "deflate"),
        ("deflate-raw", "deflate"),
        ("br", "br"),
        ("gzip,br", "gzip, br"),
        ("br,deflate", "BR, identity, Deflate"),
    ] {
        let response =
            coded_response(&client, port, &format!("/coded?{codings}&{label}"), None).await?;
        assert_eq!(response.headers()["x-accept"], "gzip, deflate, br");
        assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
        assert!(!response.headers().contains_key(header::CONTENT_LENGTH));
        let body = response.into_body().collect(usize::MAX).await?;
        assert!(body == sample(), "{codings} as {label}");
    }
    Ok(())
}

#[tokio::test]
async fn decoded_frames_stay_small() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    let mut body = coded_response(&client, port, "/zeros", None)
        .await?
        .into_body();
    let mut total = 0;
    while let Some(frame) = body.frame().await {
        let data = frame?.into_data().expect("data");
        assert!(data.len() <= 64 * 1024, "{}", data.len());
        assert!(data.iter().all(|&byte| byte == 0));
        total += data.len();
    }
    assert_eq!(total, 16 << 20);
    Ok(())
}

#[tokio::test]
async fn bodies_pass_through_unless_the_client_asked() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    // A caller that names its own codings reads what the server sent.
    let response = coded_response(&client, port, "/coded?gzip&gzip", Some("gzip")).await?;
    assert_eq!(response.headers()["x-accept"], "gzip");
    assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
    let body = response.into_body().collect(usize::MAX).await?;
    assert!(body == encode("gzip", &sample()));
    // An unknown coding stays as it is.
    let response = coded_response(&client, port, "/coded?gzip&gzip, zstd", None).await?;
    assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip, zstd");
    let body = response.into_body().collect(usize::MAX).await?;
    assert!(body == encode("gzip", &sample()));
    // A HEAD response has no body to decode.
    let head = request(
        Method::HEAD,
        &format!("http://127.0.0.1:{port}/coded?br&br"),
        "",
    );
    let response = client.send(head).await?;
    assert_eq!(response.headers()[header::CONTENT_ENCODING], "br");
    Ok(())
}

#[tokio::test]
async fn corrupt_coded_bodies_fail_when_read() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let client = HttpClient::new().allow_private_addresses();
    let response = coded_response(&client, port, "/corrupt", None).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let error = response.into_body().collect(usize::MAX).await.unwrap_err();
    assert!(matches!(error, Error::Transport(_)), "{error}");
    Ok(())
}

#[tokio::test]
async fn private_addresses_are_refused_unless_allowed() -> anyhow::Result<()> {
    let (port, connections) = server().await?;
    let client = HttpClient::new();
    for host in ["127.0.0.1", "localhost", "[::1]"] {
        let url = format!("http://{host}:{port}/echo");
        let error = client
            .send(request(Method::GET, &url, ""))
            .await
            .unwrap_err();
        assert!(matches!(error, Error::PermissionDenied), "{host}: {error}");
    }
    assert_eq!(connections.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn other_schemes_are_invalid() -> anyhow::Result<()> {
    let client = HttpClient::new();
    let error = client
        .send(request(Method::GET, "ftp://example.com/", ""))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
    Ok(())
}

#[test]
fn requests_need_a_tokio_runtime() {
    let client = HttpClient::new();
    let send = client.send(request(Method::GET, "http://example.com/", ""));
    let error = futures_executor(send).unwrap_err();
    assert!(matches!(error, Error::Configuration(_)), "{error}");
}

/// Poll a future to completion outside any Tokio runtime.
fn futures_executor<F: std::future::Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(std::task::Waker::noop());
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut context) {
            return output;
        }
    }
}

fn app(backend: Backend, port: u16, client: HttpClient) -> anyhow::Result<App> {
    let policy = FetchPolicy::deny_all().allow_origin(&format!("http://127.0.0.1:{port}"))?;
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().outbound(FetchService::new(client, policy)))
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            ..Limits::default()
        })
        .build()?)
}

#[tokio::test]
async fn javascript_fetch_reaches_the_server_on_every_engine() -> anyhow::Result<()> {
    let (port, _) = server().await?;
    let url = format!("http://127.0.0.1:{port}/echo");
    for backend in backends() {
        let mut app = app(backend, port, HttpClient::new().allow_private_addresses())?;
        let result: Value = app.call_json("send", &[json!(url)]).await?;
        assert_eq!(result, json!({ "status": 200, "echoed": "from-js" }));
    }
    for backend in backends() {
        // The policy allows the origin; the transport refuses where it leads.
        let mut app = app(backend, port, HttpClient::new())?;
        let result: Value = app.call_json("send", &[json!(url)]).await?;
        assert_eq!(result, json!({ "refused": "PERMISSION_DENIED" }));
    }
    Ok(())
}

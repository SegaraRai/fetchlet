//! Deterministic, network-free transport for the lab and framework regressions.

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body::Frame;
use serde_json::json;

use fetchlet::{Body, FetchPolicy, FetchService, HostServices, Response, http, transport_fn};

pub fn services() -> fetchlet::Result<HostServices> {
    let policy = FetchPolicy::deny_all().allow_origin("https://api.fetchlet.test")?;
    let service = FetchService::new(transport_fn(respond), policy)
        .rewrite(|request| {
            if request.uri().path() == "/rewrite-denied" {
                *request.uri_mut() = "http://127.0.0.1/private".parse().expect("static URI");
            }
            Ok(())
        })
        .credentials(|url, headers| {
            if url.host_str() == Some("api.fetchlet.test") {
                headers.insert("x-host-key", http::HeaderValue::from_static("mock-key"));
            }
            Ok(())
        });

    HostServices::new()
        .outbound(service.clone())
        .service("API", service)?
        .env("MODE", "mock")
}

async fn respond(request: fetchlet::Request) -> fetchlet::Result<Response> {
    match request.uri().path() {
        "/redirect" => return redirect("/data"),
        "/redirect-denied" => return redirect("http://127.0.0.1/private"),
        "/slow" => tokio::time::sleep(Duration::from_secs(60)).await,
        "/delayed" => tokio::time::sleep(Duration::from_millis(5)).await,
        "/chunked" => return chunked(false),
        "/chunked-open" => return chunked(true),
        _ => {}
    }

    let authenticated =
        request.headers().get("x-host-key") == Some(&http::HeaderValue::from_static("mock-key"));
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let body = request.into_body().collect(1024 * 1024).await?;
    let payload = json!({
        "method": method,
        "path": path,
        "body": body.as_ref(),
        "authenticated": authenticated,
    });

    http::Response::builder()
        .header("content-type", "application/json")
        .header("set-cookie", "first=1")
        .header("set-cookie", "second=2")
        .body(Body::from(payload.to_string()))
        .map_err(|error| fetchlet::Error::Transport(error.to_string()))
}

/// A body that arrives in chunks without a declared length, so the guest
/// reads it from a Rust body source. With `open`, it stays open after the
/// first chunk.
struct Chunked {
    chunks: Vec<Bytes>,
    open: bool,
}

impl http_body::Body for Chunked {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if self.chunks.is_empty() {
            return if self.open {
                Poll::Pending
            } else {
                Poll::Ready(None)
            };
        }
        Poll::Ready(Some(Ok(Frame::data(self.chunks.remove(0)))))
    }
}

fn chunked(open: bool) -> fetchlet::Result<Response> {
    let chunks = if open {
        vec![Bytes::from_static(b"alpha;")]
    } else {
        [&b"alpha;"[..], b"beta;", b"gamma;"]
            .map(Bytes::from_static)
            .to_vec()
    };
    http::Response::builder()
        .header("content-type", "text/plain")
        .body(Body::from_http_body(Chunked { chunks, open }))
        .map_err(|error| fetchlet::Error::Transport(error.to_string()))
}

fn redirect(location: &str) -> fetchlet::Result<Response> {
    http::Response::builder()
        .status(302)
        .header("location", location)
        .body(Body::empty())
        .map_err(|error| fetchlet::Error::Transport(error.to_string()))
}

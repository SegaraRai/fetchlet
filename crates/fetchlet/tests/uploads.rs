#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Request bodies JavaScript streams to an outbound fetch: the transport
//! reads each chunk as JavaScript produces it, a redirect that would resend
//! the body fails the fetch, and the JavaScript stream stops when the
//! transport no longer reads it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body::Body as _;
use serde_json::{Value, json};

use fetchlet::http::{self, StatusCode, header};
use fetchlet::{
    App, Backend, Body, FetchPolicy, FetchService, HostServices, Limits, Module, Request,
    RequireHttp2, Response, transport_fn,
};

const SOURCE: &str = include_str!("fixtures/uploads.js");

fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::boa(),
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

/// What the transport saw of each request: its chunks as they arrived, and
/// whether it had to use HTTP/2.
#[derive(Default)]
struct Seen {
    chunks: Vec<Vec<String>>,
    http2: Vec<bool>,
}

/// Answer `/echo` with the body read chunk by chunk, `/307` with a redirect
/// to it, and `/early` at once without reading the body.
fn uploader(
    backend: Backend,
    limits: Limits,
    policy: FetchPolicy,
) -> anyhow::Result<(App, Arc<Mutex<Seen>>)> {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    let transport = transport_fn(move |request: Request| {
        let record = record.clone();
        async move {
            record
                .lock()
                .unwrap()
                .http2
                .push(request.extensions().get::<RequireHttp2>().is_some());
            let path = request.uri().path().to_owned();
            if path == "/307" {
                return Ok(http::Response::builder()
                    .status(StatusCode::TEMPORARY_REDIRECT)
                    .header(header::LOCATION, "/echo")
                    .body(Body::empty())
                    .unwrap());
            }
            if path == "/early" {
                return Ok(Response::new(Body::from("early")));
            }
            let mut body = request.into_body();
            let mut chunks = Vec::new();
            while let Some(frame) =
                std::future::poll_fn(|context| std::pin::Pin::new(&mut body).poll_frame(context))
                    .await
            {
                if let Ok(chunk) = frame?.into_data() {
                    chunks.push(String::from_utf8_lossy(&chunk).into_owned());
                }
            }
            let text = chunks.concat();
            record.lock().unwrap().chunks.push(chunks);
            Ok(Response::new(Body::from(text)))
        }
    });
    let app = App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().outbound(FetchService::new(transport, policy)))
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            ..limits
        })
        .build()?;
    Ok((app, seen))
}

fn policy() -> FetchPolicy {
    FetchPolicy::deny_all()
        .allow_origin("https://upload.test")
        .unwrap()
}

async fn upload(app: &mut App, path: &str, chunks: Value) -> anyhow::Result<Value> {
    let url = format!("https://upload.test{path}");
    Ok(app.call_json("upload", &[json!(url), chunks]).await?)
}

#[tokio::test]
async fn chunks_reach_the_transport_as_javascript_produces_them() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, seen) = uploader(backend, Limits::default(), policy())?;
        assert_eq!(
            upload(&mut app, "/echo", json!(["a", "bc", "d"])).await?,
            json!({ "status": 200, "text": "abcd" })
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.chunks, vec![vec!["a", "bc", "d"]]);
        // The policy keeps a streamed body off HTTP/1.x by default.
        assert_eq!(seen.http2, vec![true]);
    }
    Ok(())
}

#[tokio::test]
async fn the_policy_can_allow_http1() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, seen) =
            uploader(backend, Limits::default(), policy().allow_http1_streaming())?;
        upload(&mut app, "/echo", json!(["a"])).await?;
        assert_eq!(seen.lock().unwrap().http2, vec![false]);
    }
    Ok(())
}

#[tokio::test]
async fn a_redirect_that_would_resend_the_body_fails() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, seen) = uploader(backend, Limits::default(), policy())?;
        assert_eq!(
            upload(&mut app, "/307", json!(["a"])).await?,
            json!({ "error": "TRANSPORT" })
        );
        // The redirect was not followed.
        assert_eq!(seen.lock().unwrap().http2.len(), 1);
    }
    Ok(())
}

#[tokio::test]
async fn the_stream_stops_when_the_transport_drops_the_body() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = uploader(backend, Limits::default(), policy())?;
        assert_eq!(
            upload(&mut app, "/early", json!(["a", "b"])).await?,
            json!({ "status": 200, "text": "early" })
        );
        let record = app.call_json("record", &[]).await?;
        assert_eq!(record, json!({ "reads": 0, "cancelled": true }));
    }
    Ok(())
}

#[tokio::test]
async fn producer_failures_and_budgets_fail_the_fetch() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = uploader(backend, Limits::default(), policy())?;
        assert_eq!(
            upload(&mut app, "/echo", json!(["a", "fail"])).await?,
            json!({ "error": "TRANSPORT" })
        );

        let limits = Limits {
            request_body_chunks: Some(2),
            ..Limits::default()
        };
        let (mut app, _) = uploader(backend, limits, policy())?;
        assert_eq!(
            upload(&mut app, "/echo", json!(["a", "b", "c"])).await?,
            json!({ "error": "LIMIT_EXCEEDED" })
        );
        assert_eq!(
            app.call_json("record", &[]).await?["cancelled"],
            json!(true)
        );

        let limits = Limits {
            request_body_bytes: Some(3),
            ..Limits::default()
        };
        let (mut app, _) = uploader(backend, limits, policy())?;
        assert_eq!(
            upload(&mut app, "/echo", json!(["ab", "cd"])).await?,
            json!({ "error": "LIMIT_EXCEEDED" })
        );
    }
    Ok(())
}

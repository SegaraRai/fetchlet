#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Background work registered with `fetchlet.waitUntil`.

use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body::Frame;
use serde_json::json;
use tokio::sync::mpsc;

use fetchlet::{
    App, AppHandle, Backend, Body, Error, FetchPolicy, FetchService, HostServices, Limits, Module,
    Response, WorkerOptions, http, transport_fn,
};

const SOURCE: &str = include_str!("fixtures/streaming.js");

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

fn limits() -> Limits {
    Limits {
        timeout: Some(Duration::from_secs(5)),
        background_timeout: Some(Duration::from_secs(5)),
        ..Limits::default()
    }
}

fn get(path: &str) -> fetchlet::Request {
    http::Request::builder()
        .uri(format!("https://stream.test{path}"))
        .body(Body::empty())
        .unwrap()
}

async fn text(response: Response) -> fetchlet::Result<String> {
    let body = response.into_body().collect(1024).await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn number(handle: &AppHandle, export: &str) -> fetchlet::Result<u64> {
    Ok(handle.call_json(export, &[]).await?.as_u64().unwrap())
}

/// A body the test feeds chunk by chunk.
struct ChannelBody(mpsc::Receiver<Bytes>);

impl http_body::Body for ChannelBody {
    type Data = Bytes;

    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.0
            .poll_recv(context)
            .map(|chunk| chunk.map(|chunk| Ok(Frame::data(chunk))))
    }
}

/// Host services whose outbound fetch answers with a body the test feeds.
fn upstream() -> anyhow::Result<(HostServices, mpsc::Sender<Bytes>)> {
    let (sender, receiver) = mpsc::channel(1);
    let receiver = Arc::new(Mutex::new(Some(receiver)));
    let transport = transport_fn(move |_| {
        let receiver = receiver.lock().unwrap().take();
        async move {
            let receiver = receiver.ok_or(Error::Transport("one upstream call".into()))?;
            Ok(Response::new(Body::from_http_body(ChannelBody(receiver))))
        }
    });
    let policy = FetchPolicy::deny_all().allow_origin("https://upstream.test")?;
    Ok((
        HostServices::new().outbound(FetchService::new(transport, policy)),
        sender,
    ))
}

async fn spawn(
    backend: Backend,
    limits: Limits,
    services: HostServices,
) -> anyhow::Result<AppHandle> {
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(limits)
        .host_services(services)
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await?)
}

#[tokio::test(flavor = "current_thread")]
async fn the_response_is_sent_before_its_background_work_finishes() -> anyhow::Result<()> {
    for backend in backends() {
        let (services, upstream) = upstream()?;
        let handle = spawn(backend, limits(), services).await?;

        // The background task waits for upstream bytes that the test sends
        // only after it has the response.
        let response = handle.fetch(get("/background-upstream")).await?;
        assert_eq!(response.status(), 202);
        assert_eq!(text(response).await?, "1:none");
        upstream.send(Bytes::from_static(b"abc")).await?;
        upstream.send(Bytes::from_static(b"de")).await?;
        drop(upstream);

        // The worker settles background work before the next command, with
        // the invocation's host scope still open for its fetch.
        assert_eq!(number(&handle, "backgroundBytes").await?, 5);
        assert_eq!(number(&handle, "backgroundDone").await?, 1);
        assert_eq!(number(&handle, "pendingTimers").await?, 0);
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_app_runs_background_work_explicitly_or_before_its_next_call() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(limits())
            .build()?;
        assert_eq!(
            app.call_json("topLevelWaitUntil", &[]).await?,
            json!("INVOCATION_CLOSED")
        );

        let response = app.fetch(get("/background?wait=20")).await?;
        assert_eq!(text(response).await?, "1:none");
        assert!(app.has_background());
        assert_eq!(app.call_json("backgroundDone", &[]).await?, json!(1));
        assert!(!app.has_background());

        app.fetch(get("/background?wait=5")).await?;
        app.finish_background().await?;
        assert!(!app.has_background());
        assert_eq!(app.call_json("backgroundDone", &[]).await?, json!(2));

        // Rejected tasks are absorbed; the others still run.
        app.fetch(get("/background-rejected")).await?;
        app.finish_background().await?;
        assert_eq!(app.call_json("backgroundDone", &[]).await?, json!(3));

        // Background work registered while a body streams runs after the body.
        let response = app.fetch(get("/background-stream")).await?;
        assert_eq!(text(response).await?, "tick-0;tick-1;");
        app.finish_background().await?;
        assert_eq!(app.call_json("backgroundDone", &[]).await?, json!(4));
        assert_eq!(app.call_json("pendingTimers", &[]).await?, json!(0));
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn background_budgets_bound_the_work() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            background_timeout: Some(Duration::from_millis(100)),
            background_tasks: Some(2),
            ..limits()
        };

        // Registrations beyond the budget throw in the handler.
        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(limits.clone())
            .build()?;
        let response = app.fetch(get("/background-many?count=3")).await?;
        assert_eq!(text(response).await?, "2:LIMIT_EXCEEDED");
        app.finish_background().await?;
        assert_eq!(app.call_json("backgroundDone", &[]).await?, json!(2));

        // Work that cannot settle in time retires the instance.
        app.fetch(get("/background-forever")).await?;
        assert!(matches!(
            app.finish_background().await,
            Err(Error::DeadlineExceeded)
        ));
        assert!(!app.is_reusable());

        // A worker rebuilds the instance for the next command.
        let handle = spawn(backend, limits, HostServices::new()).await?;
        handle.fetch(get("/background-forever")).await?;
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

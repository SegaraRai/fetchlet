#![cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]

use std::num::NonZeroUsize;
use std::time::Duration;

use bytes::Bytes;
use std::future::poll_fn;
use std::pin::Pin;

use http_body::Body as _;
use serde_json::{Value, json};

use fetchlet::{
    App, AppHandle, Backend, Body, Error, Limits, Module, Response, WorkerOptions, http,
};

const SOURCE: &str = include_str!("fixtures/streaming.js");

fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::Boa,
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

fn limits(timeout: Duration, response_body_bytes: Option<usize>) -> Limits {
    Limits {
        timeout: Some(timeout),
        response_body_bytes,
        ..Limits::default()
    }
}

async fn spawn(backend: Backend, limits: Limits) -> fetchlet::Result<AppHandle> {
    App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(limits)
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await
}

fn get(path: &str) -> fetchlet::Request {
    http::Request::builder()
        .uri(format!("https://stream.test{path}"))
        .body(Body::empty())
        .unwrap()
}

async fn next_frame(body: &mut Body) -> Option<fetchlet::Result<Bytes>> {
    poll_fn(|context| Pin::new(&mut *body).poll_frame(context))
        .await
        .map(|frame| frame.map(|frame| frame.into_data().unwrap()))
}

async fn frames(response: Response) -> Vec<fetchlet::Result<Bytes>> {
    let mut body = response.into_body();
    let mut frames = Vec::new();
    while let Some(frame) = next_frame(&mut body).await {
        match frame {
            Ok(data) => frames.push(Ok(data)),
            Err(error) => {
                frames.push(Err(error));
                break;
            }
        }
    }
    frames
}

async fn number(handle: &AppHandle, export: &str) -> fetchlet::Result<u64> {
    Ok(handle.call_json(export, &[]).await?.as_u64().unwrap())
}

#[tokio::test(flavor = "current_thread")]
async fn a_handle_streams_frames_as_javascript_produces_them() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), None)).await?;
        let response = handle.fetch(get("/ticks?count=3&wait=20")).await?;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/plain");
        let frames: Vec<Bytes> = frames(response)
            .await
            .into_iter()
            .collect::<Result<_, _>>()?;
        assert_eq!(
            frames,
            [&b"tick-0;"[..], b"tick-1;", b"tick-2;"].map(Bytes::from_static),
        );
        // The invocation ended with its body: its timers are gone and the
        // same instance serves the next call.
        assert_eq!(number(&handle, "pendingTimers").await?, 0);
        assert_eq!(number(&handle, "sequence").await?, 1);
        assert_eq!(number(&handle, "cancelled").await?, 0);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_app_collects_a_streamed_body() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(limits(Duration::from_secs(5), None))
            .build()?;
        let response = app.fetch(get("/ticks?count=3&wait=5")).await?;
        assert_eq!(
            response.into_body().collect(64).await?.as_ref(),
            b"tick-0;tick-1;tick-2;"
        );
        assert!(app.is_reusable());
        assert_eq!(app.call_json("pendingTimers", &[]).await?, json!(0));
        let response = app.fetch(get("/large?count=3")).await?;
        assert_eq!(response.into_body().collect(120_000).await?.len(), 120_000);
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn the_response_budget_covers_the_whole_streamed_body() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), Some(100_000))).await?;
        let response = handle.fetch(get("/large?count=5")).await?;
        let frames = frames(response).await;
        assert!(matches!(
            frames.last(),
            Some(Err(Error::LimitExceeded("response body bytes")))
        ));
        let delivered: usize = frames.iter().flatten().map(Bytes::len).sum();
        assert!(delivered <= 100_000);
        // The JavaScript stream was cancelled and the instance kept.
        assert_eq!(number(&handle, "cancelled").await?, 1);
        assert_eq!(number(&handle, "sequence").await?, 1);

        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(limits(Duration::from_secs(5), Some(100_000)))
            .build()?;
        assert!(matches!(
            app.fetch(get("/large?count=5")).await,
            Err(Error::LimitExceeded("response body bytes"))
        ));
        assert_eq!(app.call_json("cancelled", &[]).await?, json!(1));
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn the_deadline_covers_the_whole_streamed_body() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_millis(150), None)).await?;
        let response = handle.fetch(get("/forever?wait=10")).await?;
        let frames = frames(response).await;
        assert!(frames.len() > 1);
        assert!(matches!(frames.last(), Some(Err(Error::DeadlineExceeded))));
        // A fresh instance serves the next call.
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_a_body_cancels_the_javascript_stream() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), None)).await?;

        // Dropped while the worker waits for a read that never settles: the
        // abandoned evaluation retires the instance.
        let mut body = handle.fetch(get("/pending")).await?.into_body();
        let first = next_frame(&mut body).await.unwrap()?;
        assert_eq!(first.as_ref(), b"start;");
        drop(body);
        assert_eq!(number(&handle, "sequence").await?, 1);
        assert_eq!(number(&handle, "cancelled").await?, 0);

        // Dropped while the worker waits for queue room, between pulls: the
        // stream is cancelled cooperatively and the instance stays.
        let mut body = handle.fetch(get("/burst")).await?.into_body();
        assert!(!next_frame(&mut body).await.unwrap()?.is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(body);
        assert_eq!(number(&handle, "sequence").await?, 2);
        assert_eq!(number(&handle, "cancelled").await?, 1);
        assert_eq!(number(&handle, "pendingTimers").await?, 0);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn a_stream_error_reaches_the_body_consumer() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), None)).await?;
        let frames = frames(handle.fetch(get("/error?wait=5")).await?).await;
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].as_ref().unwrap().as_ref(), b"ok;");
        assert!(
            matches!(&frames[1], Err(Error::JavaScript(message)) if message.contains("stream failure"))
        );
        assert_eq!(number(&handle, "sequence").await?, 1);
        assert_eq!(
            handle.call_json("pendingTimers", &[]).await?,
            Value::from(0)
        );
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn a_body_not_handed_to_the_host_ends_with_its_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), None)).await?;
        let response = handle.fetch(get("/withheld")).await?;
        let id: u64 = response.headers()["x-body"].to_str()?.parse()?;
        assert!(response.into_body().collect(0).await?.is_empty());
        // Nothing from that invocation stays reachable by a later one.
        assert_eq!(number(&handle, "openBodies").await?, 0);
        assert_eq!(number(&handle, "pendingTimers").await?, 0);
        assert_eq!(handle.call_json("probe", &[json!(id)]).await?, Value::Null);
        assert_eq!(number(&handle, "cancelled").await?, 1);

        // A later Fetch call cannot name an earlier body as its own.
        let open = handle.fetch(get("/forever?wait=10")).await?;
        drop(open);
        assert_eq!(
            handle.call_json("probe", &[json!(id + 1)]).await?,
            Value::Null
        );
        handle.shutdown().await?;
    }
    Ok(())
}

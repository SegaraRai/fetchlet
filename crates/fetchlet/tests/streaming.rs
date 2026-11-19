#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

use std::num::NonZeroUsize;
use std::time::Duration;

use std::future::poll_fn;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body::{Body as _, Frame, SizeHint};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use fetchlet::{
    App, AppHandle, Backend, Body, Error, Limits, Module, Response, WorkerOptions, http,
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

/// A request body that the test feeds chunk by chunk.
struct ChannelBody {
    receiver: mpsc::Receiver<Bytes>,
    declared: Option<u64>,
}

impl http_body::Body for ChannelBody {
    type Data = Bytes;

    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.receiver
            .poll_recv(context)
            .map(|chunk| chunk.map(|chunk| Ok(Frame::data(chunk))))
    }

    fn size_hint(&self) -> SizeHint {
        self.declared.map(SizeHint::with_exact).unwrap_or_default()
    }
}

fn post(path: &str, declared: Option<u64>) -> (mpsc::Sender<Bytes>, fetchlet::Request) {
    let (sender, receiver) = mpsc::channel(1);
    let body = Body::from_http_body(ChannelBody { receiver, declared });
    let request = http::Request::builder()
        .method("POST")
        .uri(format!("https://stream.test{path}"))
        .body(body)
        .unwrap();
    (sender, request)
}

async fn released(sender: &mpsc::Sender<Bytes>) -> bool {
    tokio::time::timeout(Duration::from_secs(5), sender.closed())
        .await
        .is_ok()
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
        assert!(
            matches!(frames.last(), Some(Err(Error::DeadlineExceeded))),
            "{backend:?}: the body ended with {:?}",
            frames.last()
        );
        // A fresh instance serves the next call.
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn a_consumer_that_stalls_past_the_deadline_reads_deadline_exceeded() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_millis(150), None)).await?;
        let response = handle.fetch(get("/forever?wait=10")).await?;
        // The queue fills while nothing reads, so the deadline passes while the
        // worker waits for room rather than while JavaScript produces a chunk.
        tokio::time::sleep(Duration::from_millis(400)).await;
        let frames = frames(response).await;
        assert!(
            matches!(frames.last(), Some(Err(Error::DeadlineExceeded))),
            "{backend:?}: the body ended with {:?}",
            frames.last()
        );
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
        // The head carried the first chunk; let the worker enter the pull
        // that never settles before dropping the body.
        tokio::time::sleep(Duration::from_millis(100)).await;
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

#[tokio::test(flavor = "current_thread")]
async fn a_request_body_streams_into_javascript_as_it_arrives() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), None)).await?;
        let (sender, request) = post("/echo", None);
        let response = handle.fetch(request).await?;
        let mut body = response.into_body();
        // Each chunk reaches the handler, and comes back, before the next exists.
        for chunk in [&b"first;"[..], b"second;"] {
            sender.send(Bytes::from_static(chunk)).await?;
            assert_eq!(next_frame(&mut body).await.unwrap()?.as_ref(), chunk);
        }
        drop(sender);
        assert!(next_frame(&mut body).await.is_none());
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn the_request_budget_covers_the_streamed_body() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            request_body_bytes: Some(4),
            ..limits(Duration::from_secs(5), None)
        };
        let handle = spawn(backend, limits).await?;

        // Chunks arrive as the producer sends them, within the budget.
        let (sender, request) = post("/count", None);
        let feed = async {
            for chunk in [&b"ab"[..], b"cd"] {
                sender.send(Bytes::from_static(chunk)).await.unwrap();
            }
            drop(sender);
        };
        let (response, ()) = tokio::join!(handle.fetch(request), feed);
        assert_eq!(response?.into_body().collect(64).await?.as_ref(), b"2:4");

        // The budget applies to the bytes read so far.
        let (sender, request) = post("/count", None);
        let feed = async {
            for chunk in [&b"abc"[..], b"def"] {
                if sender.send(Bytes::from_static(chunk)).await.is_err() {
                    break;
                }
            }
        };
        let (response, ()) = tokio::join!(handle.fetch(request), feed);
        let response = response?;
        assert_eq!(response.status(), 500);
        assert_eq!(
            response.into_body().collect(64).await?.as_ref(),
            b"LIMIT_EXCEEDED"
        );

        // A declared length over the budget fails before JavaScript runs.
        let (_sender, request) = post("/count", Some(5));
        assert!(matches!(
            handle.fetch(request).await,
            Err(Error::LimitExceeded("request body bytes"))
        ));
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_unread_request_body_is_released_with_its_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, limits(Duration::from_secs(5), None)).await?;
        let (sender, request) = post("/ignore", None);
        let response = handle.fetch(request).await?;
        assert!(response.into_body().collect(0).await?.is_empty());
        assert!(released(&sender).await);

        // Dropping a response that reads the request body releases it too.
        let (sender, request) = post("/echo", None);
        let mut body = handle.fetch(request).await?.into_body();
        sender.send(Bytes::from_static(b"x")).await?;
        assert_eq!(next_frame(&mut body).await.unwrap()?.as_ref(), b"x");
        drop(body);
        assert!(released(&sender).await);
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

/// An App whose outbound fetch answers with a body the test feeds.
async fn spawn_with_upstream(
    backend: Backend,
    limits: Limits,
) -> anyhow::Result<(AppHandle, mpsc::Sender<Bytes>)> {
    let (sender, receiver) = mpsc::channel(1);
    let receiver = std::sync::Arc::new(std::sync::Mutex::new(Some(receiver)));
    let transport = fetchlet::transport_fn(move |_| {
        let receiver = receiver.lock().unwrap().take();
        async move {
            let receiver = receiver.ok_or(Error::Transport("one upstream call".into()))?;
            let body = ChannelBody {
                receiver,
                declared: None,
            };
            Ok(Response::new(Body::from_http_body(body)))
        }
    });
    let policy = fetchlet::FetchPolicy::deny_all().allow_origin("https://upstream.test")?;
    let services =
        fetchlet::HostServices::new().outbound(fetchlet::FetchService::new(transport, policy));
    let handle = App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(limits)
        .host_services(services)
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await?;
    Ok((handle, sender))
}

#[tokio::test(flavor = "current_thread")]
async fn an_upstream_body_streams_through_the_handler() -> anyhow::Result<()> {
    for backend in backends() {
        let (handle, upstream) =
            spawn_with_upstream(backend, limits(Duration::from_secs(5), None)).await?;
        let response = handle.fetch(get("/proxy")).await?;
        assert_eq!(response.status(), 200);
        let mut body = response.into_body();
        // Each upstream chunk reaches the client before the next exists.
        for chunk in [&b"up-1;"[..], b"up-2;"] {
            upstream.send(Bytes::from_static(chunk)).await?;
            assert_eq!(next_frame(&mut body).await.unwrap()?.as_ref(), chunk);
        }
        drop(upstream);
        assert!(next_frame(&mut body).await.is_none());
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn the_response_budget_covers_a_streamed_upstream_body() -> anyhow::Result<()> {
    for backend in backends() {
        let (handle, upstream) =
            spawn_with_upstream(backend, limits(Duration::from_secs(5), Some(8))).await?;
        let mut body = handle.fetch(get("/proxy")).await?.into_body();
        upstream.send(Bytes::from_static(b"12345")).await?;
        assert_eq!(next_frame(&mut body).await.unwrap()?.as_ref(), b"12345");
        upstream.send(Bytes::from_static(b"67890")).await?;
        // The upstream read fails, which errors the handler's body.
        assert!(matches!(next_frame(&mut body).await, Some(Err(_))));
        assert!(released(&upstream).await);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_or_aborting_releases_the_upstream_body() -> anyhow::Result<()> {
    for backend in backends() {
        // The client drops the proxied body.
        let (handle, upstream) =
            spawn_with_upstream(backend, limits(Duration::from_secs(5), None)).await?;
        let mut body = handle.fetch(get("/proxy")).await?.into_body();
        upstream.send(Bytes::from_static(b"x")).await?;
        assert_eq!(next_frame(&mut body).await.unwrap()?.as_ref(), b"x");
        drop(body);
        assert!(released(&upstream).await);
        assert_eq!(number(&handle, "sequence").await?, 1);
        handle.shutdown().await?;

        // The handler aborts the fetch after the first chunk.
        let (handle, upstream) =
            spawn_with_upstream(backend, limits(Duration::from_secs(5), None)).await?;
        upstream.send(Bytes::from_static(b"first")).await?;
        let response = handle.fetch(get("/abort-upstream")).await?;
        assert_eq!(
            response.into_body().collect(64).await?.as_ref(),
            b"first|stopped"
        );
        assert!(released(&upstream).await);
        handle.shutdown().await?;
    }
    Ok(())
}

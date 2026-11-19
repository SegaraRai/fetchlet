#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

use std::future::{Future, poll_fn};
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use serde_json::json;
use tokio::sync::mpsc;

use fetchlet::{
    App, AppHandle, Backend, Body, Error, FetchPolicy, FetchService, HostServices, Module, Request,
    Response, WorkerOptions, http, transport_fn,
};

const SOURCE: &str = include_str!("fixtures/handle.js");

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

async fn spawn(backend: Backend) -> fetchlet::Result<AppHandle> {
    App::builder(backend)
        .module(Module::new(SOURCE))
        .spawn(WorkerOptions::new(NonZeroUsize::new(1).unwrap()))
        .await
}

fn request() -> Request {
    http::Request::builder()
        .method("POST")
        .uri("https://example.test/")
        .body(Body::from(vec![0, 128, 255]))
        .unwrap()
}

async fn poll_pending<F: Future>(mut future: Pin<&mut F>) {
    poll_fn(|context| {
        assert!(future.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn shared_function_and_fetch_contracts() -> anyhow::Result<()> {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AppHandle>();

    for backend in backends() {
        let handle = spawn(backend).await?;
        let other = handle.clone();
        assert_eq!(
            handle.call_json("add", &[json!(20), json!(22)]).await?,
            json!(42)
        );
        let value: serde_json::Value = handle.call("echo", &json!({"name": "日本語😀"})).await?;
        assert_eq!(value, json!({"name": "日本語😀"}));

        let task = tokio::spawn(async move { other.call_json("sequence", &[]).await });
        assert_eq!(task.await??, json!(1));
        assert_eq!(handle.call_json("sequence", &[]).await?, json!(2));
        assert!(matches!(
            handle.call_json("fail", &[]).await,
            Err(Error::JavaScript(_))
        ));
        assert_eq!(handle.call_json("sequence", &[]).await?, json!(3));

        let response = handle
            .fetch_with_context(request(), &json!({"name": "scoped"}))
            .await?;
        assert_eq!(response.status(), 201);
        assert_eq!(response.headers()["x-context"], "scoped");
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        assert_eq!(
            response.into_body().collect(3).await?.as_ref(),
            &[0, 128, 255]
        );
        assert_eq!(
            handle.fetch(request()).await?.headers()["x-context"],
            "none"
        );

        handle.shutdown().await?;
        assert!(matches!(
            handle.call_json("sequence", &[]).await,
            Err(Error::WorkerClosed)
        ));
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_backpressure_and_shutdown() -> anyhow::Result<()> {
    for backend in backends() {
        let (started, mut receive_start) = mpsc::unbounded_channel();
        let policy = FetchPolicy::deny_all().allow_origin("https://signal.test")?;
        let service = FetchService::new(
            transport_fn(move |_| {
                let started = started.clone();
                async move {
                    started.send(()).unwrap();
                    Ok(Response::new(Body::empty()))
                }
            }),
            policy,
        );
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(HostServices::new().service("SIGNAL", service)?)
            .spawn(WorkerOptions::new(NonZeroUsize::new(1).unwrap()))
            .await?;
        assert_eq!(handle.call_json("sequence", &[]).await?, json!(1));

        let pending_handle = handle.clone();
        let running = tokio::spawn(async move { pending_handle.call_json("never", &[]).await });
        tokio::time::timeout(Duration::from_secs(2), receive_start.recv())
            .await?
            .expect("call entered the worker");

        let mut accepted = Box::pin(handle.call_json("sequence", &[]));
        poll_pending(accepted.as_mut()).await;
        let mut waiting = Box::pin(handle.call_json("sequence", &[]));
        poll_pending(waiting.as_mut()).await;

        let mut shutdown = Box::pin(handle.shutdown());
        poll_pending(shutdown.as_mut()).await;
        assert!(matches!(waiting.await, Err(Error::WorkerClosed)));

        running.abort();
        assert!(running.await.unwrap_err().is_cancelled());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), accepted).await??,
            json!(1),
        );
        tokio::time::timeout(Duration::from_secs(2), shutdown).await??;
        assert!(matches!(
            handle.fetch(request()).await,
            Err(Error::WorkerClosed)
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn startup_errors_reach_the_caller() -> anyhow::Result<()> {
    for backend in backends() {
        let result = App::builder(backend)
            .module(Module::new("throw new Error('initialization failed');"))
            .spawn(WorkerOptions::new(NonZeroUsize::new(1).unwrap()))
            .await;
        assert!(matches!(result, Err(Error::JavaScript(_))));
    }
    Ok(())
}

const PATCHED_FETCH: &str = include_str!("fixtures/patched-fetch.js");

#[tokio::test(flavor = "current_thread")]
async fn a_replaced_global_fetch_still_passes_the_policy() -> anyhow::Result<()> {
    for backend in backends() {
        let policy = FetchPolicy::deny_all().allow_origin("https://allowed.test")?;
        let outbound = FetchService::new(
            transport_fn(|_| async { Ok(Response::new(Body::empty())) }),
            policy,
        );
        let handle = App::builder(backend)
            .module(Module::new(PATCHED_FETCH))
            .host_services(HostServices::new().outbound(outbound))
            .spawn(WorkerOptions::new(NonZeroUsize::new(1).unwrap()))
            .await?;
        assert_eq!(
            handle.call_json("patched", &[]).await?,
            json!({ "status": 200, "denied": "rejected", "calls": 2 }),
        );
        handle.shutdown().await?;
    }
    Ok(())
}

/// A transport's background task, such as a pooled connection, keeps
/// running between calls on every engine, so the next call can reuse it
/// from any worker.
#[tokio::test(flavor = "current_thread")]
async fn tasks_host_futures_spawn_run_between_calls() -> anyhow::Result<()> {
    for backend in backends() {
        let (ran, mut receive_ran) = mpsc::unbounded_channel();
        let policy = FetchPolicy::deny_all().allow_origin("https://allowed.test")?;
        let outbound = FetchService::new(
            transport_fn(move |_| {
                let ran = ran.clone();
                async move {
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        let _ = ran.send(());
                    });
                    Ok(Response::new(Body::empty()))
                }
            }),
            policy,
        );
        let handle = App::builder(backend)
            .module(Module::new(PATCHED_FETCH))
            .host_services(HostServices::new().outbound(outbound))
            .spawn(WorkerOptions::new(NonZeroUsize::new(1).unwrap()))
            .await?;
        handle.call_json("patched", &[]).await?;
        tokio::time::timeout(Duration::from_secs(2), receive_ran.recv())
            .await?
            .expect("the spawned task ran after the call");
        handle.shutdown().await?;
    }
    Ok(())
}

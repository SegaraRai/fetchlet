#![cfg(any(feature = "quickjs", feature = "v8"))]

//! JavaScript that never returns to the event loop stops at the invocation
//! deadline, and its instance retires. QuickJS polls an interrupt handler;
//! V8 terminates its isolate when the deadline drops the call. Boa has no
//! interrupt to build on yet (docs/research/interrupts-and-heap-limits.md).

use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

use serde_json::json;

use fetchlet::{App, Backend, Error, Instances, Limits, Module, WorkerOptions};

const SOURCE: &str = include_str!("fixtures/interrupts.js");

/// The deadline of each call.
const TIMEOUT: Duration = Duration::from_millis(200);

/// How long past the deadline a stop may take: the interrupt poll, the
/// unwinding and a busy test machine.
const SLACK: Duration = Duration::from_secs(5);

fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

fn limits() -> Limits {
    Limits {
        timeout: Some(TIMEOUT),
        ..Limits::default()
    }
}

fn app(backend: Backend) -> anyhow::Result<App> {
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(limits())
        .build()?)
}

#[tokio::test]
async fn the_deadline_stops_javascript_that_never_yields() -> anyhow::Result<()> {
    for backend in backends() {
        let name = format!("{backend:?}");
        for export in [
            "spin",
            "caught",
            "later",
            "microtasks",
            "backtrack",
            "recurse",
        ] {
            let mut app = app(backend)?;
            assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
            let started = Instant::now();
            let error = app.call_json(export, &[]).await.unwrap_err();
            let elapsed = started.elapsed();
            assert!(
                matches!(error, Error::DeadlineExceeded),
                "{name} {export}: {error:?}"
            );
            assert!(
                elapsed < TIMEOUT + SLACK,
                "{name} {export} stopped after {elapsed:?}"
            );
            // The stopped instance's state is unknown, so it runs nothing more.
            assert!(!app.is_reusable(), "{name} {export}");
            assert!(
                matches!(
                    app.call_json("ready", &[]).await,
                    Err(Error::InstanceUnavailable)
                ),
                "{name} {export}"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn work_within_the_deadline_is_unaffected() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend)?;
        for _ in 0..3 {
            assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
        }
        assert!(app.is_reusable());
        // Without a timeout nothing is armed.
        let mut unlimited = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(Limits::default())
            .build()?;
        assert_eq!(unlimited.call_json("ready", &[]).await?, json!("ready"));
    }
    Ok(())
}

#[tokio::test]
async fn a_pool_replaces_a_stopped_instance() -> anyhow::Result<()> {
    for backend in backends() {
        let mut options = WorkerOptions::new(NonZeroUsize::new(4).unwrap());
        options.instances = Instances::fixed(NonZeroUsize::new(1).unwrap());
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(limits())
            .spawn(options)
            .await?;
        let error = handle.call_json("spin", &[]).await.unwrap_err();
        assert!(matches!(error, Error::DeadlineExceeded), "{error:?}");
        assert_eq!(handle.call_json("ready", &[]).await?, json!("ready"));
        handle.shutdown().await?;
    }
    Ok(())
}

#![cfg(any(feature = "quickjs", feature = "v8"))]

//! An instance that reaches its heap limit stops with
//! `LimitExceeded("engine heap")`, the process survives, and the instance
//! retires. QuickJS counts its allocations against `memory_limit_bytes`; V8
//! stops its isolate near `heap_limit_bytes` and refuses `ArrayBuffer`
//! storage past `array_buffer_limit_bytes`
//! (docs/research/interrupts-and-heap-limits.md).

use std::num::NonZeroUsize;

use serde_json::json;

use fetchlet::{App, Backend, Error, Instances, Module, WorkerOptions};

const SOURCE: &str = include_str!("fixtures/heap.js");

const MIB: usize = 1 << 20;

/// Each engine with a heap limit well above what the fixture needs to
/// start, and with V8's array buffers limited to 16 MiB.
fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::QuickJs(fetchlet::QuickJsOptions {
            memory_limit_bytes: Some(32 * MIB),
            ..fetchlet::QuickJsOptions::default()
        }),
        #[cfg(feature = "v8")]
        Backend::V8(fetchlet::V8Options {
            heap_limit_bytes: Some(64 * MIB),
            array_buffer_limit_bytes: Some(16 * MIB),
            ..fetchlet::V8Options::default()
        }),
    ]
}

fn build(backend: Backend, source: &str) -> fetchlet::Result<App> {
    App::builder(backend).module(Module::new(source)).build()
}

#[tokio::test]
async fn the_heap_limit_stops_javascript_and_retires_the_instance() -> anyhow::Result<()> {
    for backend in backends() {
        for export in ["grow", "swallow"] {
            let mut app = build(backend, SOURCE)?;
            assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
            let error = app.call_json(export, &[]).await.unwrap_err();
            assert!(
                matches!(error, Error::LimitExceeded("engine heap")),
                "{backend:?} {export}: {error:?}"
            );
            assert!(!app.is_reusable(), "{backend:?} {export}");
            assert!(
                matches!(
                    app.call_json("ready", &[]).await,
                    Err(Error::InstanceUnavailable)
                ),
                "{backend:?} {export}"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn the_heap_limit_stops_the_module() -> anyhow::Result<()> {
    let greedy = format!("{SOURCE}\nfetchletExports.grow();\n");
    for backend in backends() {
        let error = build(backend, &greedy).err();
        assert!(
            matches!(error, Some(Error::LimitExceeded("engine heap"))),
            "{backend:?}: {error:?}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_pool_replaces_an_instance_that_reached_its_heap_limit() -> anyhow::Result<()> {
    for backend in backends() {
        let mut options = WorkerOptions::new(NonZeroUsize::new(4).unwrap());
        options.instances = Instances::fixed(NonZeroUsize::new(1).unwrap());
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .spawn(options)
            .await?;
        let error = handle.call_json("grow", &[]).await.unwrap_err();
        assert!(
            matches!(error, Error::LimitExceeded("engine heap")),
            "{backend:?}: {error:?}"
        );
        assert_eq!(handle.call_json("ready", &[]).await?, json!("ready"));
        handle.shutdown().await?;
    }
    Ok(())
}

#[cfg(feature = "v8")]
#[tokio::test]
async fn array_buffers_past_their_budget_throw_a_range_error() -> anyhow::Result<()> {
    let backend = Backend::V8(fetchlet::V8Options {
        array_buffer_limit_bytes: Some(16 * MIB),
        ..fetchlet::V8Options::default()
    });
    let mut app = build(backend, SOURCE)?;
    assert_eq!(
        app.call_json("buffer", &[json!(8 * MIB)]).await?,
        json!(8 * MIB)
    );
    assert_eq!(
        app.call_json("buffer", &[json!(32 * MIB)]).await?,
        json!("RangeError")
    );
    // A refused buffer is JavaScript's to handle; the instance stays.
    assert!(app.is_reusable());
    assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
    Ok(())
}

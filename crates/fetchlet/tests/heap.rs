#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! An instance that reaches its heap limit stops with
//! `LimitExceeded("engine heap")`, the process survives, and the instance
//! retires. `Limits::heap_bytes` is the budget: QuickJS counts its
//! allocations against it; V8 stops its isolate near it and refuses
//! `ArrayBuffer` storage past `array_buffer_limit_bytes`. An engine that
//! cannot enforce it, Boa, refuses to build
//! (docs/research/interrupts-and-heap-limits.md).

use std::num::NonZeroUsize;

use serde_json::json;

use fetchlet::{App, Backend, Error, Instances, Limits, Module, WorkerOptions};

const SOURCE: &str = include_str!("fixtures/heap.js");

const MIB: usize = 1 << 20;

/// Each engine that bounds its heap, with a heap budget well above what the
/// fixture needs to start, and with V8's array buffers limited to 16 MiB.
fn backends() -> Vec<(Backend, Limits)> {
    vec![
        #[cfg(feature = "quickjs")]
        (Backend::quickjs(), heap(32 * MIB)),
        #[cfg(feature = "v8")]
        (
            Backend::V8(fetchlet::V8Options {
                array_buffer_limit_bytes: Some(16 * MIB),
                ..fetchlet::V8Options::default()
            }),
            heap(64 * MIB),
        ),
    ]
}

fn heap(bytes: usize) -> Limits {
    Limits {
        heap_bytes: Some(bytes),
        ..Limits::default()
    }
}

fn build(backend: Backend, limits: &Limits, source: &str) -> fetchlet::Result<App> {
    App::builder(backend)
        .module(Module::new(source))
        .limits(limits.clone())
        .build()
}

#[tokio::test]
async fn the_heap_limit_stops_javascript_and_retires_the_instance() -> anyhow::Result<()> {
    for (backend, limits) in backends() {
        for export in ["grow", "swallow"] {
            let mut app = build(backend, &limits, SOURCE)?;
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
    for (backend, limits) in backends() {
        let error = build(backend, &limits, &greedy).err();
        assert!(
            matches!(error, Some(Error::LimitExceeded("engine heap"))),
            "{backend:?}: {error:?}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_pool_replaces_an_instance_that_reached_its_heap_limit() -> anyhow::Result<()> {
    for (backend, limits) in backends() {
        let mut options = WorkerOptions::new(NonZeroUsize::new(4).unwrap());
        options.instances = Instances::fixed(NonZeroUsize::new(1).unwrap());
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .limits(limits)
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
    let mut app = build(backend, &Limits::default(), SOURCE)?;
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

/// Below the minimum, V8 would end the process while the isolate starts,
/// before the heap limit can stop it.
#[cfg(feature = "v8")]
#[tokio::test]
async fn a_v8_heap_budget_below_the_minimum_is_refused() -> anyhow::Result<()> {
    let small = heap(fetchlet::MIN_V8_HEAP_LIMIT_BYTES - 1);
    match build(Backend::v8(), &small, SOURCE).err() {
        Some(Error::Configuration(message)) => {
            assert!(message.contains("heap_bytes"), "{message}");
        }
        other => panic!("expected a configuration error, got {other:?}"),
    }
    let least = heap(fetchlet::MIN_V8_HEAP_LIMIT_BYTES);
    let mut app = build(Backend::v8(), &least, SOURCE)?;
    assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
    Ok(())
}

/// Boa has no heap limit, so a heap budget would go unenforced: the App,
/// and a pool, refuse to build instead.
#[cfg(feature = "boa")]
#[tokio::test]
async fn a_heap_budget_on_boa_is_refused() -> anyhow::Result<()> {
    assert!(!Backend::boa().bounds_heap());
    match build(Backend::boa(), &heap(64 * MIB), SOURCE).err() {
        Some(Error::Configuration(message)) => {
            assert!(message.contains("heap_bytes"), "{message}");
            assert!(message.contains("Boa"), "{message}");
        }
        other => panic!("expected a configuration error, got {other:?}"),
    }
    let spawned = App::builder(Backend::boa())
        .module(Module::new(SOURCE))
        .limits(heap(64 * MIB))
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await;
    assert!(
        matches!(spawned, Err(Error::Configuration(_))),
        "{:?}",
        spawned.err()
    );
    // Without the budget, Boa builds as before.
    build(Backend::boa(), &Limits::default(), SOURCE)?;
    Ok(())
}

#[tokio::test]
async fn a_zero_heap_budget_is_refused() {
    for (backend, _) in backends() {
        assert!(
            matches!(
                build(backend, &heap(0), SOURCE).err(),
                Some(Error::Configuration(_))
            ),
            "{backend:?}"
        );
    }
}

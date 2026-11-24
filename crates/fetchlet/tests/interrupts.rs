#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! JavaScript that never returns to the event loop stops at the invocation
//! deadline, past `Limits::busy_timeout`, or past `Limits::startup_timeout`
//! while the module is evaluated, and its instance retires. QuickJS polls
//! an interrupt handler; V8 is terminated by the caller's timer or by a
//! watchdog thread; Boa stops at its next promise job or host call, so the
//! cases that do neither run on there
//! (docs/research/interrupts-and-heap-limits.md).

use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use fetchlet::{
    App, Backend, Error, Functions, HostServices, Instances, Limits, Module, WorkerOptions,
};

const SOURCE: &str = include_str!("fixtures/interrupts.js");

/// The deadline, busy timeout or startup timeout of each case.
const TIMEOUT: Duration = Duration::from_millis(200);

/// How long past the timeout a stop may take: the interrupt poll or
/// watchdog interval, the unwinding and a busy test machine.
const SLACK: Duration = Duration::from_secs(5);

/// How long `CLOCK.sleep()` waits outside JavaScript.
const SLEEP: Duration = Duration::from_millis(50);

/// Every case, each with the engines that stop it.
const CASES: &[(&str, Engines)] = &[
    ("spin", Engines::Interruptible),
    ("caught", Engines::Interruptible),
    ("later", Engines::Interruptible),
    ("backtrack", Engines::Interruptible),
    ("recurse", Engines::Interruptible),
    ("microtasks", Engines::All),
    ("host", Engines::All),
];

#[derive(Clone, Copy, PartialEq)]
enum Engines {
    /// QuickJS and V8, which stop JavaScript inside the interpreter.
    Interruptible,
    /// Boa too: the case reaches a promise job or a host call.
    All,
}

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

fn stops(backend: &Backend, engines: Engines) -> bool {
    engines == Engines::All || !format!("{backend:?}").starts_with("Boa")
}

fn services() -> HostServices {
    let clock = Functions::new()
        .sync_method("tick", |_| Ok(Value::Null))
        .method("sleep", |_| async {
            tokio::time::sleep(SLEEP).await;
            Ok(Value::Null)
        });
    HostServices::new().functions("CLOCK", clock).unwrap()
}

fn build(backend: Backend, source: &str, limits: Limits) -> fetchlet::Result<App> {
    App::builder(backend)
        .module(Module::new(source))
        .host_services(services())
        .limits(limits)
        .build()
}

/// Run `export` and check that it fails with `expected` within the timeout
/// plus slack, and that the instance then refuses to run.
async fn assert_stops(
    mut app: App,
    export: &str,
    expected: fn(&Error) -> bool,
    name: &str,
) -> anyhow::Result<()> {
    assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
    let started = Instant::now();
    let error = app.call_json(export, &[]).await.unwrap_err();
    let elapsed = started.elapsed();
    assert!(expected(&error), "{name} {export}: {error:?}");
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
    Ok(())
}

#[tokio::test]
async fn the_deadline_stops_javascript_that_never_yields() -> anyhow::Result<()> {
    let limits = Limits {
        timeout: Some(TIMEOUT),
        ..Limits::default()
    };
    for backend in backends() {
        let name = format!("{backend:?}");
        for (export, engines) in CASES {
            if stops(&backend, *engines) {
                let app = build(backend, SOURCE, limits.clone())?;
                let deadline = |error: &Error| matches!(error, Error::DeadlineExceeded);
                assert_stops(app, export, deadline, &name).await?;
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn the_busy_timeout_stops_javascript_without_a_deadline() -> anyhow::Result<()> {
    let limits = Limits {
        busy_timeout: Some(TIMEOUT),
        ..Limits::default()
    };
    for backend in backends() {
        let name = format!("{backend:?}");
        for (export, engines) in CASES {
            if stops(&backend, *engines) {
                let app = build(backend, SOURCE, limits.clone())?;
                let busy =
                    |error: &Error| matches!(error, Error::LimitExceeded("engine busy time"));
                assert_stops(app, export, busy, &name).await?;
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn javascript_that_yields_outlasts_the_busy_timeout() -> anyhow::Result<()> {
    let limits = Limits {
        busy_timeout: Some(TIMEOUT),
        ..Limits::default()
    };
    for backend in backends() {
        let mut app = build(backend, SOURCE, limits.clone())?;
        // Eight sleeps run twice the busy timeout in total.
        let started = Instant::now();
        let result = app.call_json("patient", &[json!(8)]).await?;
        assert_eq!(result, json!("patient"));
        assert!(started.elapsed() > TIMEOUT, "{backend:?}");
        assert!(app.is_reusable(), "{backend:?}");
        // Without a timeout nothing is armed.
        let mut unlimited = build(backend, SOURCE, Limits::default())?;
        assert_eq!(unlimited.call_json("ready", &[]).await?, json!("ready"));
    }
    Ok(())
}

#[tokio::test]
async fn the_startup_timeout_stops_the_module() -> anyhow::Result<()> {
    let limits = Limits {
        startup_timeout: Some(TIMEOUT),
        ..Limits::default()
    };
    // A loop that calls the host, so that Boa stops it too. It runs in a
    // function: Boa's top-level script exhausts its value stack in such a
    // loop before the timeout on a slow machine.
    let stuck = format!(
        "{SOURCE}
(() => {{
  for (;;) {{
    try {{
      CLOCK.tick();
    }} catch {{}}
  }}
}})();
"
    );
    for backend in backends() {
        let started = Instant::now();
        let error = build(backend, &stuck, limits.clone()).err();
        let elapsed = started.elapsed();
        assert!(
            matches!(error, Some(Error::DeadlineExceeded)),
            "{backend:?}: {error:?}"
        );
        assert!(elapsed < TIMEOUT + SLACK, "{backend:?} after {elapsed:?}");
        // A module that finishes in time builds as usual.
        let mut app = build(backend, SOURCE, limits.clone())?;
        assert_eq!(app.call_json("ready", &[]).await?, json!("ready"));
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
            .host_services(services())
            .limits(Limits {
                busy_timeout: Some(TIMEOUT),
                ..Limits::default()
            })
            .spawn(options)
            .await?;
        let error = handle.call_json("microtasks", &[]).await.unwrap_err();
        assert!(
            matches!(error, Error::LimitExceeded("engine busy time")),
            "{backend:?}: {error:?}"
        );
        assert_eq!(handle.call_json("ready", &[]).await?, json!("ready"));
        handle.shutdown().await?;
    }
    Ok(())
}

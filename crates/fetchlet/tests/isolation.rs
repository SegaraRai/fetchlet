//! Instances whose engine runs in a child process (`AppBuilder::isolation`):
//! calls, host functions and Fetch handlers cross the process boundary on
//! every engine, the parent stops JavaScript that does not return, also on
//! Boa, and a child that ends or is stopped retires its instance
//! (docs/research/process-isolation.md).
//!
//! The parent starts this test executable as the child, so `main` serves
//! as an isolated instance first and runs the tests itself.

use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

use serde_json::json;

use fetchlet::{
    App, Backend, Body, ChannelEnd, ChannelEvent, CloseFrame, Error, Functions, HostServices,
    Isolation, Limits, Message, Module, ProcessOptions, Requirements, WorkerOptions, http,
};

const SOURCE: &str = include_str!("fixtures/isolation.js");

/// Handlers that stream their response bodies from timers.
const STREAMING: &str = include_str!("fixtures/streaming.js");

/// Guests that open channels of env bindings.
const CHANNELS: &str = include_str!("fixtures/channels.js");

/// Messages the FLOOD channel service sends.
const FLOOD: usize = 100;

/// Makes the child exit before it reads its configuration, as a crash
/// would.
const EXIT_AT_START: &str = "FETCHLET_ISOLATION_TEST_EXIT_AT_START";

/// The deadline or busy timeout of the cases that stop JavaScript.
const TIMEOUT: Duration = Duration::from_millis(200);

/// How long past the timeout a stop may take: the kill grace, the child's
/// exit and a busy test machine.
const SLACK: Duration = Duration::from_secs(5);

/// How long `DELAY.wait()` waits outside JavaScript.
const DELAY: Duration = Duration::from_millis(20);

type TestResult = anyhow::Result<()>;

type Test = fn() -> TestResult;

const TESTS: &[(&str, Test)] = &[
    (
        "calls_cross_the_process_boundary",
        calls_cross_the_process_boundary,
    ),
    (
        "host_functions_that_resolve_later_wake_the_child",
        host_functions_that_resolve_later_wake_the_child,
    ),
    (
        "a_fetch_handler_moves_bodies_across_the_boundary",
        a_fetch_handler_moves_bodies_across_the_boundary,
    ),
    (
        "isolation_meets_preemption_on_every_engine",
        isolation_meets_preemption_on_every_engine,
    ),
    (
        "the_deadline_stops_javascript_that_never_yields",
        the_deadline_stops_javascript_that_never_yields,
    ),
    (
        "the_busy_timeout_stops_javascript_without_a_deadline",
        the_busy_timeout_stops_javascript_without_a_deadline,
    ),
    (
        "channels_cross_the_process_boundary",
        channels_cross_the_process_boundary,
    ),
    (
        "a_pool_streams_bodies_from_isolated_instances",
        a_pool_streams_bodies_from_isolated_instances,
    ),
    (
        "a_client_that_goes_away_aborts_the_request_signal",
        a_client_that_goes_away_aborts_the_request_signal,
    ),
    (
        "a_pool_replaces_a_stopped_isolated_instance",
        a_pool_replaces_a_stopped_isolated_instance,
    ),
    (
        "a_dropped_call_retires_the_instance",
        a_dropped_call_retires_the_instance,
    ),
    (
        "a_child_that_ends_at_startup_reports_instance_lost",
        a_child_that_ends_at_startup_reports_instance_lost,
    ),
    (
        "the_memory_budget_retires_the_instance",
        the_memory_budget_retires_the_instance,
    ),
    ("invalid_options_are_refused", invalid_options_are_refused),
];

fn main() -> std::process::ExitCode {
    if std::env::var_os(EXIT_AT_START).is_some() {
        std::process::exit(3);
    }
    fetchlet::serve_if_child();

    // A filter, as the default test harness takes one.
    let filter = std::env::args()
        .skip(1)
        .find(|argument| !argument.starts_with('-'));
    let mut failed = 0;
    for (name, test) in TESTS {
        if filter
            .as_deref()
            .is_some_and(|filter| !name.contains(filter))
        {
            continue;
        }
        let started = Instant::now();
        match test() {
            Ok(()) => println!("test {name} ... ok ({:?})", started.elapsed()),
            Err(error) => {
                failed += 1;
                println!("test {name} ... FAILED\n{error:?}");
            }
        }
    }
    if failed == 0 {
        std::process::ExitCode::SUCCESS
    } else {
        println!("{failed} failed");
        std::process::ExitCode::FAILURE
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
        .block_on(future)
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

fn services() -> HostServices {
    let delay = Functions::new().method("wait", |request| async move {
        let (step,): (u64,) = request.args()?;
        tokio::time::sleep(DELAY).await;
        Ok(json!(step))
    });
    HostServices::new().functions("DELAY", delay).unwrap()
}

fn build_with(
    backend: Backend,
    module: Module,
    limits: Limits,
    options: ProcessOptions,
) -> fetchlet::Result<App> {
    App::builder(backend)
        .module(module)
        .host_services(services())
        .limits(limits)
        .isolation(Isolation::Process(options))
        .build()
}

fn build(backend: Backend, limits: Limits) -> fetchlet::Result<App> {
    build_with(backend, Module::new(SOURCE), limits, ProcessOptions::new())
}

fn calls_cross_the_process_boundary() -> TestResult {
    block_on(async {
        for backend in backends() {
            let mut app = build(backend, Limits::default())?;
            let value = json!({"name": "日本語😀", "list": [1, 2.5, null, true]});
            assert_eq!(
                app.call_json("echo", std::slice::from_ref(&value)).await?,
                value,
                "{backend:?}"
            );
            assert!(
                matches!(app.call_json("fail", &[]).await, Err(Error::JavaScript(_))),
                "{backend:?}"
            );
            // A JavaScript error leaves the instance reusable, as in-process.
            assert!(app.is_reusable(), "{backend:?}");
            assert_eq!(
                app.call_json("echo", &[json!(1)]).await?,
                json!(1),
                "{backend:?}"
            );
        }
        Ok(())
    })
}

fn host_functions_that_resolve_later_wake_the_child() -> TestResult {
    block_on(async {
        for backend in backends() {
            let mut app = build(backend, Limits::default())?;
            let started = Instant::now();
            assert_eq!(
                app.call_json("delayed", &[json!(4)]).await?,
                json!(6),
                "{backend:?}"
            );
            assert!(started.elapsed() >= DELAY * 4, "{backend:?}");
            assert!(app.is_reusable(), "{backend:?}");
        }
        Ok(())
    })
}

fn a_fetch_handler_moves_bodies_across_the_boundary() -> TestResult {
    block_on(async {
        for backend in backends() {
            let mut app = build(backend, Limits::default())?;
            let request = http::Request::builder()
                .method("POST")
                .uri("https://fetchlet.test/")
                .body(Body::from(vec![0, 128, 255]))?;
            let response = app.fetch(request).await?;
            assert_eq!(response.status(), 201, "{backend:?}");
            assert_eq!(response.headers()["x-method"], "POST", "{backend:?}");
            assert_eq!(
                response.into_body().collect(3).await?.as_ref(),
                &[0, 128, 255],
                "{backend:?}"
            );
        }
        Ok(())
    })
}

fn isolation_meets_preemption_on_every_engine() -> TestResult {
    block_on(async {
        for backend in backends() {
            let module = Module::new(SOURCE).requires(Requirements::new().preemption());
            let mut app = build_with(backend, module, Limits::default(), ProcessOptions::new())?;
            assert_eq!(
                app.call_json("echo", &[json!("ok")]).await?,
                json!("ok"),
                "{backend:?}"
            );
        }
        Ok(())
    })
}

/// Run `spin` and check that it fails with `expected` within the timeout
/// plus slack, and that the instance then refuses to run.
async fn assert_stops(mut app: App, expected: fn(&Error) -> bool, name: &str) -> TestResult {
    assert_eq!(
        app.call_json("echo", &[json!(1)]).await?,
        json!(1),
        "{name}"
    );
    let started = Instant::now();
    let error = app.call_json("spin", &[]).await.unwrap_err();
    let elapsed = started.elapsed();
    assert!(expected(&error), "{name}: {error:?}");
    assert!(
        elapsed < TIMEOUT + SLACK,
        "{name} stopped after {elapsed:?}"
    );
    assert!(!app.is_reusable(), "{name}");
    assert!(
        matches!(
            app.call_json("echo", &[json!(1)]).await,
            Err(Error::InstanceUnavailable)
        ),
        "{name}"
    );
    Ok(())
}

fn the_deadline_stops_javascript_that_never_yields() -> TestResult {
    block_on(async {
        let limits = Limits {
            timeout: Some(TIMEOUT),
            ..Limits::default()
        };
        // Boa cannot stop this loop in-process; the parent ends its child.
        for backend in backends() {
            let app = build(backend, limits.clone())?;
            let deadline = |error: &Error| matches!(error, Error::DeadlineExceeded);
            assert_stops(app, deadline, &format!("{backend:?}")).await?;
        }
        Ok(())
    })
}

fn the_busy_timeout_stops_javascript_without_a_deadline() -> TestResult {
    block_on(async {
        let limits = Limits {
            busy_timeout: Some(TIMEOUT),
            ..Limits::default()
        };
        for backend in backends() {
            let app = build(backend, limits.clone())?;
            let busy = |error: &Error| matches!(error, Error::LimitExceeded("engine busy time"));
            assert_stops(app, busy, &format!("{backend:?}")).await?;
            // Awaiting the host longer than the busy timeout in total is
            // not busy.
            let mut patient = build(backend, limits.clone())?;
            assert_eq!(
                patient.call_json("delayed", &[json!(16)]).await?,
                json!(120)
            );
        }
        Ok(())
    })
}

/// Echo every message, after a greeting with the open's options.
async fn echo(mut end: ChannelEnd, options: serde_json::Value) {
    if end.send(format!("hello:{options}")).await.is_err() {
        return;
    }
    while let Some(event) = end.recv().await {
        let sent = match event {
            ChannelEvent::Message(Message::Text(text)) => end.send(format!("echo:{text}")).await,
            ChannelEvent::Message(message) => end.send(message).await,
            ChannelEvent::Close(frame) => {
                end.close(frame);
                return;
            }
            _ => Ok(()),
        };
        if sent.is_err() {
            return;
        }
    }
}

fn channel_services() -> HostServices {
    HostServices::new()
        .channel(
            "ECHO",
            fetchlet::channel_fn(|request| async move {
                tokio::spawn(echo(request.end, request.options));
                Ok(())
            }),
        )
        .unwrap()
        .channel(
            "FLOOD",
            fetchlet::channel_fn(|request| async move {
                let mut end = request.end;
                tokio::spawn(async move {
                    for index in 0..FLOOD {
                        if end.send(format!("{index:010}")).await.is_err() {
                            return;
                        }
                    }
                    end.close(CloseFrame::new(CloseFrame::NORMAL, "done"));
                });
                Ok(())
            }),
        )
        .unwrap()
}

fn channels_cross_the_process_boundary() -> TestResult {
    block_on(async {
        for backend in backends() {
            let mut app = App::builder(backend)
                .module(Module::new(CHANNELS))
                .host_services(channel_services())
                .limits(Limits {
                    timeout: Some(Duration::from_secs(10)),
                    ..Limits::default()
                })
                .isolation(Isolation::Process(ProcessOptions::new()))
                .build()?;
            // Text and bytes both ways, then a closing handshake.
            let result = app.call_json("echo", &[json!(["a", "b"])]).await?;
            assert_eq!(
                result,
                json!({
                    "messages": [r#"hello:{"greeting":"hi"}"#, "echo:a", "echo:b", [1, 2, 3]],
                    "close": { "code": 1000, "reason": "done" },
                }),
                "{backend:?}"
            );
            // Messages the service sends faster than the guest reads, each
            // delivered after a wake that crosses to the child.
            let result = app.call_json("drain", &[json!("FLOOD")]).await?;
            assert_eq!(
                result,
                json!({ "received": FLOOD, "close": { "code": 1000, "reason": "done" } }),
                "{backend:?}"
            );
            assert!(app.is_reusable(), "{backend:?}");
        }
        Ok(())
    })
}

fn a_pool_streams_bodies_from_isolated_instances() -> TestResult {
    block_on(async {
        for backend in backends() {
            let handle = App::builder(backend)
                .module(Module::new(STREAMING))
                .limits(Limits {
                    timeout: Some(Duration::from_secs(5)),
                    ..Limits::default()
                })
                .isolation(Isolation::Process(ProcessOptions::new()))
                .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
                .await?;
            let request = http::Request::builder()
                .uri("https://stream.test/ticks?count=3&wait=20")
                .body(Body::empty())?;
            let response = handle.fetch(request).await?;
            assert_eq!(response.status(), 200, "{backend:?}");
            assert_eq!(
                response.into_body().collect(64).await?.as_ref(),
                b"tick-0;tick-1;tick-2;",
                "{backend:?}"
            );
            // The invocation ended with its body, and its timers with it.
            assert_eq!(handle.call_json("pendingTimers", &[]).await?, json!(0));
            handle.shutdown().await?;
        }
        Ok(())
    })
}

fn a_client_that_goes_away_aborts_the_request_signal() -> TestResult {
    block_on(async {
        for backend in backends() {
            let mut worker = WorkerOptions::new(NonZeroUsize::new(4).unwrap());
            worker.cancelled_calls = fetchlet::CancelledCalls::Finish;
            let handle = App::builder(backend)
                .module(Module::new(STREAMING))
                .limits(Limits {
                    timeout: Some(Duration::from_secs(5)),
                    ..Limits::default()
                })
                .isolation(Isolation::Process(ProcessOptions::new()))
                .spawn(worker)
                .await?;
            let request = http::Request::builder()
                .uri("https://stream.test/until-abort-head")
                .body(Body::empty())?;
            let started = Instant::now();
            let cancelled =
                tokio::time::timeout(Duration::from_millis(50), handle.fetch(request)).await;
            assert!(cancelled.is_err(), "{backend:?}");
            // The parent told the child that the client went away, so the
            // handler returned once its signal aborted, well before its own
            // two-second fallback, in the same instance.
            assert_eq!(
                handle.call_json("aborts", &[]).await?,
                json!(1),
                "{backend:?}"
            );
            assert!(
                started.elapsed() < Duration::from_millis(1500),
                "{backend:?}"
            );
            assert_eq!(
                handle.call_json("sequence", &[]).await?,
                json!(1),
                "{backend:?}"
            );
            handle.shutdown().await?;
        }
        Ok(())
    })
}

fn a_pool_replaces_a_stopped_isolated_instance() -> TestResult {
    block_on(async {
        for backend in backends() {
            let handle = App::builder(backend)
                .module(Module::new(SOURCE))
                .host_services(services())
                .limits(Limits {
                    timeout: Some(TIMEOUT),
                    ..Limits::default()
                })
                .isolation(Isolation::Process(ProcessOptions::new()))
                .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
                .await?;
            let error = handle.call_json("spin", &[]).await.unwrap_err();
            assert!(
                matches!(error, Error::DeadlineExceeded),
                "{backend:?}: {error:?}"
            );
            assert_eq!(
                handle.call_json("echo", &[json!(2)]).await?,
                json!(2),
                "{backend:?}"
            );
            handle.shutdown().await?;
        }
        Ok(())
    })
}

fn a_dropped_call_retires_the_instance() -> TestResult {
    block_on(async {
        for backend in backends() {
            let mut app = build(backend, Limits::default())?;
            let dropped = tokio::time::timeout(TIMEOUT, app.call_json("spin", &[])).await;
            assert!(dropped.is_err(), "{backend:?}");
            assert!(!app.is_reusable(), "{backend:?}");
            assert!(
                matches!(
                    app.call_json("echo", &[json!(1)]).await,
                    Err(Error::InstanceUnavailable)
                ),
                "{backend:?}"
            );
        }
        Ok(())
    })
}

fn a_child_that_ends_at_startup_reports_instance_lost() -> TestResult {
    // SAFETY: this runner is single-threaded, and the children started
    // before this point have ended with their tests.
    unsafe { std::env::set_var(EXIT_AT_START, "1") };
    let result = build(backends()[0], Limits::default());
    // SAFETY: as above.
    unsafe { std::env::remove_var(EXIT_AT_START) };
    match result {
        Err(Error::InstanceLost(detail)) => {
            assert!(detail.contains('3'), "{detail}");
            Ok(())
        }
        Err(error) => anyhow::bail!("expected InstanceLost, got {error:?}"),
        Ok(_) => anyhow::bail!("expected InstanceLost, got an instance"),
    }
}

/// A memory budget that the instance starts within. On Linux the budget
/// bounds the data segment, where V8 on x64 also reserves its code range,
/// which needs more than 512 MiB.
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn budget(backend: &Backend) -> usize {
    if cfg!(target_os = "linux") && format!("{backend:?}").starts_with("V8") {
        1 << 30
    } else {
        128 << 20
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn the_memory_budget_retires_the_instance() -> TestResult {
    block_on(async {
        for backend in backends() {
            let options = ProcessOptions::new().memory_bytes(budget(&backend));
            let mut app = build_with(backend, Module::new(SOURCE), Limits::default(), options)?;
            assert_eq!(
                app.call_json("echo", &[json!(1)]).await?,
                json!(1),
                "{backend:?}"
            );
            let error = app.call_json("grow", &[]).await.unwrap_err();
            assert!(
                matches!(error, Error::LimitExceeded("process memory")),
                "{backend:?}: {error:?}"
            );
            assert!(!app.is_reusable(), "{backend:?}");
        }
        Ok(())
    })
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn the_memory_budget_retires_the_instance() -> TestResult {
    // The budget is enforced on Windows, Linux and macOS; elsewhere it is
    // refused.
    let options = ProcessOptions::new().memory_bytes(256 << 20);
    let result = build_with(
        backends()[0],
        Module::new(SOURCE),
        Limits::default(),
        options,
    );
    assert!(
        matches!(result, Err(Error::Configuration(_))),
        "{:?}",
        result.err()
    );
    Ok(())
}

fn invalid_options_are_refused() -> TestResult {
    let options = ProcessOptions::new().memory_bytes(0);
    let result = build_with(
        backends()[0],
        Module::new(SOURCE),
        Limits::default(),
        options,
    );
    assert!(
        matches!(result, Err(Error::Configuration(_))),
        "{:?}",
        result.err()
    );
    let missing = ProcessOptions::new().program(fetchlet::Program::Path("does-not-exist".into()));
    let result = build_with(
        backends()[0],
        Module::new(SOURCE),
        Limits::default(),
        missing,
    );
    assert!(
        matches!(result, Err(Error::Configuration(_))),
        "{:?}",
        result.err()
    );
    Ok(())
}

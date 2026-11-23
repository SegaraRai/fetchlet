#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Function bindings: JavaScript calls Rust functions as the methods of
//! `env.NAME`, sync or async, with JSON arguments and results.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::FutureExt;
use serde_json::{Value, json};

use fetchlet::{
    App, AppHandle, Backend, Body, Context, Error, FunctionError, FunctionRequest, Functions,
    HostServices, Limits, Module, WorkerOptions, http,
};

const SOURCE: &str = include_str!("fixtures/functions.js");

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

/// The trusted caller identity, chosen by the Rust host.
#[derive(Clone)]
struct Caller(&'static str);

/// Counts its drops, to see that a call's future went away.
struct Dropped(Arc<AtomicUsize>);

impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct State {
    dropped: Arc<AtomicUsize>,
    handle: OnceLock<AppHandle>,
}

fn functions(state: Arc<State>) -> Functions {
    let forever = state.clone();
    let reenter = state.clone();
    Functions::new()
        .method("add", |request: FunctionRequest| async move {
            let (left, right): (i64, i64) = request.args()?;
            Ok(json!(left + right))
        })
        .sync_method("escape", |request| {
            let (text,): (String,) = request.args()?;
            Ok(json!(text.replace('\'', "''")))
        })
        .method("echo", |request| async move {
            let args: Vec<Value> = request.args()?;
            Ok(Value::Array(args))
        })
        .sync_method("echoSync", |request| Ok(request.raw_args().clone()))
        .sync_method("nothing", |_| Ok(Value::Null))
        .sync_method("method", |request| Ok(json!(request.method())))
        .method("find", |_| async {
            Err(FunctionError::new("no such user").code("NOT_FOUND"))
        })
        .sync_method("fail", |_| Err(FunctionError::new("plain failure")))
        .method("denied", |_| async {
            Err::<Value, _>(Error::PermissionDenied)?;
            Ok(Value::Null)
        })
        .sync_method("panics", |_| panic!("a sync method panicked"))
        .method("panicsLater", |_| async {
            panic!("an async method panicked")
        })
        .method("large", |_| async { Ok(json!("x".repeat(100_000))) })
        .method("forever", move |_| {
            let dropped = Dropped(forever.dropped.clone());
            async move {
                let _dropped = dropped;
                std::future::pending::<()>().await;
                Ok(Value::Null)
            }
        })
        .method("reenter", {
            let state = reenter.clone();
            move |_| {
                let handle = state.handle.get().cloned();
                async move {
                    let handle = handle.expect("the handle is set");
                    Ok(handle.call_json("ping", &[]).await?)
                }
            }
        })
        .sync_method("reenterSync", move |_| {
            let handle = reenter.handle.get().expect("the handle is set");
            // The refusal comes before the call waits for anything.
            let refused = handle
                .call_json("ping", &[])
                .now_or_never()
                .expect("a refusal at once");
            Ok(refused?)
        })
        .method("whoami", |request| async move {
            let caller = request
                .context()
                .get::<Caller>()
                .map_or("anonymous", |Caller(name)| name);
            Ok(json!(caller))
        })
}

fn services(state: Arc<State>) -> HostServices {
    HostServices::new()
        .env("MODE", "test")
        .unwrap()
        .functions("DB", functions(state))
        .unwrap()
}

fn limits() -> Limits {
    Limits {
        timeout: Some(Duration::from_secs(10)),
        bridge_message_bytes: Some(64 * 1024),
        ..Limits::default()
    }
}

fn app(backend: Backend, limits: Limits) -> anyhow::Result<(App, Arc<State>)> {
    let state = Arc::new(State::default());
    let app = App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(services(state.clone()))
        .limits(limits)
        .build()?;
    Ok((app, state))
}

#[tokio::test]
async fn the_binding_is_a_frozen_object_of_its_methods() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = app(backend, limits())?;
        assert_eq!(
            app.call_json("shape", &[]).await?,
            json!({
                "keys": [
                    "add", "denied", "echo", "echoSync", "escape", "fail", "find", "forever",
                    "large", "method", "nothing", "panics", "panicsLater", "reenter",
                    "reenterSync", "whoami",
                ],
                "frozen": true,
                "prototype": true,
                "envKeys": ["MODE", "DB"],
                "writable": false,
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn sync_and_async_methods_return_json() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = app(backend, limits())?;
        assert_eq!(
            app.call_json("calls", &[]).await?,
            json!({
                "promise": true,
                "sum": 5,
                "escaped": "it''s",
                "echoed": [null, null, { "nested": [1, "two"] }],
                "empty": null,
                "parallel": [2, 4, 6],
                "method": "method",
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn failures_reach_javascript_as_errors() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = app(backend, limits())?;
        let errors = app.call_json("errors", &[]).await?;
        let invalid = |method: &str| {
            json!({
                "name": "TypeError",
                "message": format!("Invalid arguments for DB.{method}"),
                "code": null,
                "type": true,
            })
        };
        let host = |code: &str, message: &str| json!({ "name": "FetchletHostError", "message": message, "code": code, "type": false });
        assert_eq!(
            errors["application"],
            json!({ "name": "Error", "message": "no such user", "code": "NOT_FOUND", "type": false })
        );
        assert_eq!(
            errors["uncoded"],
            json!({ "name": "Error", "message": "plain failure", "code": null, "type": false })
        );
        assert_eq!(errors["asyncArguments"], invalid("add"));
        assert_eq!(errors["syncArguments"], invalid("escape"));
        assert_eq!(errors["missing"], invalid("escape"));
        assert_eq!(errors["extra"], invalid("escape"));
        // A fetchlet error keeps its detail in Rust.
        assert_eq!(
            errors["host"],
            host("PERMISSION_DENIED", "host operation is not permitted")
        );
        assert_eq!(
            errors["panicked"],
            host("PANICKED", "host function panicked")
        );
        assert_eq!(
            errors["asyncPanicked"],
            host("PANICKED", "host function panicked")
        );
        // JSON.stringify refuses a BigInt before Rust is called.
        assert_eq!(errors["unencodable"]["type"], true);
        assert_eq!(
            errors["tooLarge"],
            host("LIMIT_EXCEEDED", "host resource limit exceeded")
        );
        // The instance stays usable after a method panicked.
        assert_eq!(app.call_json("ping", &[]).await?, "pong");
    }
    Ok(())
}

#[tokio::test]
async fn function_calls_bounds_calls_per_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            function_calls: Some(3),
            ..limits()
        };
        let (mut app, _) = app(backend, limits)?;
        let codes = json!(["ok", "ok", "ok", "LIMIT_EXCEEDED"]);
        assert_eq!(app.call_json("limited", &[]).await?, codes);
        // The budget is per invocation.
        assert_eq!(app.call_json("limited", &[]).await?, codes);
    }
    Ok(())
}

#[tokio::test]
async fn a_call_ends_with_its_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, state) = app(backend, limits())?;
        assert_eq!(app.call_json("leave", &[]).await?, "returned");
        assert_eq!(state.dropped.load(Ordering::SeqCst), 1);

        let limits = Limits {
            timeout: Some(Duration::from_millis(200)),
            ..limits()
        };
        let (mut app, state) = self::app(backend, limits)?;
        let error = app.call_json("wait", &[]).await.unwrap_err();
        assert!(matches!(error, Error::DeadlineExceeded), "{error}");
        assert_eq!(state.dropped.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

#[tokio::test]
async fn methods_receive_the_trusted_context() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = app(backend, limits())?;
        for (context, expected) in [
            (Some(Context::new().with(Caller("alice"))), "alice"),
            (None, "anonymous"),
        ] {
            let mut request = http::Request::builder()
                .uri("https://app.test/")
                .body(Body::empty())?;
            if let Some(context) = context {
                request.extensions_mut().insert(context);
            }
            let response = app.fetch(request).await?;
            let body = response.into_body().collect(1024).await?;
            assert_eq!(body, expected.as_bytes());
        }
    }
    Ok(())
}

#[tokio::test]
async fn a_method_cannot_call_its_own_application() -> anyhow::Result<()> {
    for backend in backends() {
        let state = Arc::new(State::default());
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(services(state.clone()))
            .limits(limits())
            .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
            .await?;
        state.handle.set(handle.clone()).ok().unwrap();
        let refused = json!({
            "name": "FetchletHostError",
            "message": "reentrant application call",
            "code": "REENTRANT",
            "type": false,
        });
        assert_eq!(
            handle.call_json("reenter", &[]).await?,
            json!({ "async": refused, "sync": refused })
        );
        handle.shutdown().await?;
    }
    Ok(())
}

#[test]
fn bindings_refuse_then_duplicates_and_taken_names() {
    let configuration =
        |result: fetchlet::Result<HostServices>| matches!(result, Err(Error::Configuration(_)));
    let then = Functions::new().method("then", |_| async { Ok(Value::Null) });
    assert!(configuration(HostServices::new().functions("A", then)));
    let twice = Functions::new()
        .sync_method("run", |_| Ok(Value::Null))
        .method("run", |_| async { Ok(Value::Null) });
    assert!(configuration(HostServices::new().functions("A", twice)));
    let taken = HostServices::new().env("A", "value").unwrap();
    assert!(configuration(taken.functions("A", Functions::new())));
    let bound = HostServices::new()
        .functions("A", Functions::new())
        .unwrap();
    assert!(configuration(bound.env("A", "value")));
}

#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Function bindings: JavaScript calls Rust functions as the methods of
//! `env.NAME`, sync or async, with JSON arguments and results that carry
//! byte arrays, and channels in results.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::{Value, json};

use fetchlet::{
    App, AppHandle, Backend, Body, ChannelEnd, ChannelEvent, CloseFrame, Context, Error,
    FunctionError, FunctionRequest, FunctionResponse, Functions, HostServices, Limits, Message,
    Module, WorkerOptions, http,
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
    /// Rust's end of the channel `hold` returned.
    held: Mutex<Option<ChannelEnd>>,
}

/// A method body that panics.
fn panics(message: &str) -> Result<Value, FunctionError> {
    panic!("{message}")
}

/// The second argument of `parts`.
#[derive(Deserialize)]
struct Parts {
    nested: Vec<u8>,
    list: (Bytes, String),
}

/// Two events, then an answer to what JavaScript sends, then a close.
async fn events(mut end: ChannelEnd) {
    for index in 1..=2 {
        if end.send(format!("event {index}")).await.is_err() {
            return;
        }
    }
    if let Some(ChannelEvent::Message(Message::Text(text))) = end.recv().await {
        let _ = end.send(format!("got {text}")).await;
    }
    end.close(CloseFrame::new(CloseFrame::NORMAL, "done"));
}

fn functions(state: Arc<State>) -> Functions {
    let forever = state.clone();
    let reenter = state.clone();
    let hold = state.clone();
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
            Err::<Value, _>(FunctionError::new("no such user").code("NOT_FOUND"))
        })
        .sync_method("fail", |_| {
            Err::<Value, _>(FunctionError::new("plain failure"))
        })
        .method("denied", |_| async {
            Err::<Value, _>(Error::PermissionDenied)?;
            Ok(Value::Null)
        })
        .sync_method("panics", |_| panics("a sync method panicked"))
        .method("panicsLater", |_| async {
            panics("an async method panicked")
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
        .sync_method("parts", |request| {
            let (first, rest): (Vec<u8>, Parts) = request.args()?;
            Ok(json!({
                "first": first,
                "nested": rest.nested,
                "buffer": rest.list.0.to_vec(),
                "text": rest.list.1,
            }))
        })
        .method("sum", |request| async move {
            let (bytes,): (Bytes,) = request.args()?;
            Ok(json!(
                bytes.iter().map(|byte| u32::from(*byte)).sum::<u32>()
            ))
        })
        .method("reverse", |request| async move {
            let (mut bytes,): (Vec<u8>,) = request.args()?;
            bytes.reverse();
            Ok(bytes)
        })
        .sync_method("packet", |_| {
            let mut response =
                FunctionResponse::new(json!({ "header": "h", "body": null, "trailer": [1, null] }));
            response
                .bytes_at("/body", b"body".to_vec())?
                .bytes_at("/trailer/1", Bytes::from_static(b"t"))?;
            Ok(response)
        })
        .method("subscribe", |request| async move {
            let (topic,): (String,) = request.args()?;
            let mut response = FunctionResponse::new(json!({ "topic": topic, "events": null }));
            let end = response.channel_at("/events", request.limits())?;
            tokio::spawn(events(end));
            Ok(response)
        })
        .sync_method("open", |request| {
            let mut response = FunctionResponse::new(Value::Null);
            let mut end = response.channel_at("", request.limits())?;
            end.close(CloseFrame::new(CloseFrame::NORMAL, "bye"));
            Ok(response)
        })
        .method("hold", move |request| {
            let state = hold.clone();
            async move {
                let mut response = FunctionResponse::new(Value::Null);
                let end = response.channel_at("", request.limits())?;
                *state.held.lock().unwrap() = Some(end);
                Ok(response)
            }
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
                    "hold", "large", "method", "nothing", "open", "packet", "panics",
                    "panicsLater", "parts", "reenter", "reenterSync", "reverse", "subscribe",
                    "sum", "whoami",
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

fn invalid(method: &str) -> Value {
    json!({
        "name": "TypeError",
        "message": format!("Invalid arguments for DB.{method}"),
        "code": null,
        "type": true,
    })
}

#[tokio::test]
async fn byte_arrays_cross_both_ways() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _) = app(backend, limits())?;
        assert_eq!(
            app.call_json("binary", &[]).await?,
            json!({
                "parts": { "first": [1, 2, 255], "nested": [8, 7], "buffer": [5, 6], "text": "text" },
                "empty": { "first": [], "nested": [], "buffer": [], "text": "" },
                "sum": 5,
                "kept": [1, 2, 255],
                "reversed": { "array": true, "bytes": [255, 2, 1] },
                "packet": {
                    "header": "h",
                    "body": [98, 111, 100, 121],
                    "trailer": [1, [116]],
                    "keys": ["header", "body", "trailer"],
                },
                "wrong": invalid("sum"),
                "missing": invalid("sum"),
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn results_lend_channels_to_the_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, state) = app(backend, limits())?;
        assert_eq!(
            app.call_json("subscribe", &[]).await?,
            json!({
                "topic": "news",
                "messages": ["event 1", "event 2", "got ack"],
                "close": { "code": 1000, "reason": "done" },
            })
        );
        assert_eq!(
            app.call_json("whole", &[]).await?,
            json!({ "messages": [], "close": { "code": 1000, "reason": "bye" } })
        );

        // A channel JavaScript leaves open closes when the invocation ends.
        assert_eq!(app.call_json("keep", &[]).await?, "returned");
        let mut held = state.held.lock().unwrap().take().expect("a held channel");
        let wait = Duration::from_secs(10);
        assert_eq!(
            tokio::time::timeout(wait, held.recv()).await?,
            Some(ChannelEvent::Message(Message::from("kept")))
        );
        match tokio::time::timeout(wait, held.recv()).await? {
            Some(ChannelEvent::Close(frame)) => assert_eq!(frame.code, CloseFrame::ABNORMAL),
            other => panic!("expected a close, got {other:?}"),
        }

        // Without the Web API profile, JavaScript cannot build the object.
        assert_eq!(
            app.call_json("withoutViews", &[]).await?,
            json!({
                "name": "TypeError",
                "message": "Channels need the fetchlet Web API profile",
                "code": null,
                "type": true,
            })
        );
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

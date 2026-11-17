#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

use std::time::Duration;

use serde_json::json;

use fetchlet::{App, Backend, Body, Error, HostServices, Limits, Module, http};

const SOURCE: &str = include_str!("fixtures/app.js");

fn app(backend: Backend) -> App {
    App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().env("MODE", "test").unwrap())
        .limits(Limits {
            timeout: Some(Duration::from_millis(100)),
            ..Limits::default()
        })
        .build()
        .unwrap()
}

async fn contracts(backend: Backend) -> anyhow::Result<()> {
    let mut app = app(backend);
    let value: serde_json::Value = app.call("echo", &json!({"name":"日本語😀"})).await?;
    assert_eq!(value, json!({"name":"日本語😀"}));
    assert!(matches!(
        app.call_json("fail", &[]).await,
        Err(Error::JavaScript(_))
    ));
    assert!(app.is_reusable());
    assert!(app.call_json("toString", &[]).await.is_err());
    assert_eq!(
        app.call_json("env", &[]).await?,
        json!({"mode":"test","keys":["MODE"],"frozen":true})
    );
    let req = http::Request::builder()
        .method("POST")
        .uri("https://fetchlet.test/")
        .body(Body::from(vec![0, 128, 255]))?;
    let response = app.fetch(req).await?;
    assert_eq!(response.status(), 201);
    assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
    assert_eq!(
        response.into_body().collect(3).await?.as_ref(),
        &[0, 128, 255]
    );
    let request = http::Request::builder()
        .uri("https://fetchlet.test/context")
        .body(Body::empty())?;
    let response = app
        .fetch_with_context(request, &json!({ "name": "scoped" }))
        .await?;
    assert_eq!(response.headers()["x-context"], "scoped");
    let request = http::Request::builder()
        .uri("https://fetchlet.test/context")
        .body(Body::empty())?;
    assert!(
        !app.fetch(request)
            .await?
            .headers()
            .contains_key("x-context")
    );

    assert!(
        tokio::time::timeout(Duration::from_millis(5), app.call_json("never", &[]))
            .await
            .is_err()
    );
    assert!(!app.is_reusable());
    assert!(matches!(
        app.call_json("echo", &[json!(42)]).await,
        Err(Error::InstanceUnavailable)
    ));

    let mut timed = App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(Limits {
            timeout: Some(Duration::from_millis(5)),
            ..Limits::default()
        })
        .build()?;
    assert!(matches!(
        timed.call_json("never", &[]).await,
        Err(Error::DeadlineExceeded)
    ));
    assert!(!timed.is_reusable());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn managed_app_contracts() -> anyhow::Result<()> {
    #[cfg(feature = "quickjs")]
    contracts(Backend::quickjs()).await?;
    #[cfg(feature = "boa")]
    contracts(Backend::boa()).await?;
    #[cfg(feature = "v8")]
    contracts(Backend::v8()).await?;
    Ok(())
}

async fn console_output(backend: Backend) -> anyhow::Result<()> {
    use std::sync::{Arc, Mutex};

    use fetchlet::ConsoleLevel;

    const LOGGING: &str = r#"
        console.info("loaded");
        globalThis.fetchletExports = {
          log() {
            console.log("text", 1, { a: [true, null] });
            console.warn("careful");
            console.error(new TypeError("broken"));
            console.debug("x".repeat(4096));
            return "done";
          },
        };
    "#;
    let messages = Arc::new(Mutex::new(Vec::new()));
    let sink = messages.clone();
    let mut app = App::builder(backend)
        .module(Module::new(LOGGING))
        .host_services(HostServices::new().console(move |level, message| {
            sink.lock().unwrap().push((level, message.to_owned()));
        }))
        .limits(Limits {
            bridge_message_bytes: Some(1024),
            ..Limits::default()
        })
        .build()?;
    assert_eq!(app.call_json("log", &[]).await?, json!("done"));
    let messages = messages.lock().unwrap().clone();
    assert_eq!(messages[0], (ConsoleLevel::Info, "loaded".to_owned()));
    assert_eq!(
        messages[1],
        (ConsoleLevel::Log, r#"text 1 {"a":[true,null]}"#.to_owned())
    );
    assert_eq!(messages[2], (ConsoleLevel::Warn, "careful".to_owned()));
    assert_eq!(messages[3].0, ConsoleLevel::Error);
    assert!(messages[3].1.contains("broken"), "{}", messages[3].1);
    // A message over the bridge message budget arrives as a notice.
    assert_eq!(
        messages[4],
        (
            ConsoleLevel::Debug,
            "[fetchlet: console message dropped]".to_owned()
        )
    );
    assert_eq!(messages.len(), 5);

    // Without a sink, console calls stay harmless no-ops.
    let mut silent = App::builder(backend).module(Module::new(LOGGING)).build()?;
    assert_eq!(silent.call_json("log", &[]).await?, json!("done"));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn console_reaches_the_host_sink() -> anyhow::Result<()> {
    #[cfg(feature = "quickjs")]
    console_output(Backend::quickjs()).await?;
    #[cfg(feature = "boa")]
    console_output(Backend::boa()).await?;
    #[cfg(feature = "v8")]
    console_output(Backend::v8()).await?;
    Ok(())
}

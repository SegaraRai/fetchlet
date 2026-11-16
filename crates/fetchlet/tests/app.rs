#![cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]

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
    contracts(Backend::Boa).await?;
    #[cfg(feature = "v8")]
    contracts(Backend::v8()).await?;
    Ok(())
}

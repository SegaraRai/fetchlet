#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Byte arrays and context in calls: Rust places byte arrays in an export's
//! arguments, reads those its result holds, and attaches a trusted
//! `Context` that the function bindings of the call's invocation see.

use std::num::NonZeroUsize;
use std::time::Duration;

use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Value, json};

use fetchlet::{
    App, Backend, Call, Context, Error, FunctionRequest, Functions, HostServices, Limits, Module,
    WorkerOptions,
};

const SOURCE: &str = include_str!("fixtures/call-values.js");

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

fn services() -> HostServices {
    let keys = Functions::new().sync_method("caller", |request: FunctionRequest| {
        Ok(json!(
            request.context().get::<Caller>().map(|caller| caller.0)
        ))
    });
    HostServices::new().functions("KEYS", keys).unwrap()
}

fn limits() -> Limits {
    Limits {
        timeout: Some(Duration::from_secs(10)),
        ..Limits::default()
    }
}

fn app(backend: Backend) -> anyhow::Result<App> {
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(services())
        .limits(limits())
        .build()?)
}

#[tokio::test]
async fn the_context_reaches_function_bindings() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend)?;
        let mut call = Call::new("caller");
        call.context(Context::new().with(Caller("alice")));
        assert_eq!(app.call_with(call).await?.into_value(), json!("alice"));
        // The next invocation starts without it.
        assert_eq!(app.call_json("caller", &[]).await?, Value::Null);
    }
    Ok(())
}

#[tokio::test]
async fn byte_arrays_arrive_where_rust_put_them() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend)?;
        let mut call = Call::new("received");
        call.json(json!({ "name": "a", "image": null }));
        call.bytes(vec![4, 5]);
        call.bytes_at("/0/image", Bytes::from_static(&[1, 2, 3]))?;
        assert_eq!(
            app.call_with(call).await?.into_value(),
            json!({
                "name": "a",
                "image": { "type": "[object Uint8Array]", "data": [1, 2, 3] },
                "positional": { "type": "[object Uint8Array]", "data": [4, 5] },
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn byte_arrays_in_results_cross_as_bytes() -> anyhow::Result<()> {
    #[derive(Deserialize)]
    struct Thumbnail {
        name: String,
        image: Vec<u8>,
        list: (Bytes, String),
        encoded: Vec<u8>,
        empty: Vec<u8>,
    }

    for backend in backends() {
        let mut app = app(backend)?;
        let mut call = Call::new("thumbnail");
        call.json(json!("a"));
        let output = app.call_with(call).await?;
        assert_eq!(
            output.value(),
            &json!({
                "name": "a",
                "image": null,
                "list": [null, "text"],
                "encoded": null,
                "empty": null,
            })
        );
        assert_eq!(output.bytes_at("/image").unwrap(), &[1u8, 2, 3][..]);
        let thumbnail: Thumbnail = output.deserialize()?;
        assert_eq!(thumbnail.name, "a");
        assert_eq!(thumbnail.image, [1, 2, 3]);
        assert_eq!(thumbnail.list.0, Bytes::from_static(&[1, 2]));
        assert_eq!(thumbnail.list.1, "text");
        // The bytes themselves, not the JSON toJSON would make.
        assert_eq!(thumbnail.encoded, [9]);
        assert!(thumbnail.empty.is_empty());

        // call_json keeps the JSON alone.
        assert_eq!(
            app.call_json("thumbnail", &[json!("b")]).await?["image"],
            Value::Null
        );
        // call reads the bytes where they were.
        let raw: Vec<u8> = app.call("raw", &3).await?;
        assert_eq!(raw, [7, 7, 7]);
    }
    Ok(())
}

#[tokio::test]
async fn a_result_can_be_a_byte_array() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend)?;
        let mut call = Call::new("echo");
        call.bytes(Bytes::from_static(b"xbytes"));
        let output = app.call_with(call).await?;
        assert_eq!(output.value(), &Value::Null);
        assert_eq!(output.bytes_at("").unwrap(), &b"bytes"[..]);
        assert_eq!(output.deserialize::<Bytes>()?, Bytes::from_static(b"bytes"));
        // A result that is not JSON still fails.
        let error = app.call_json("nothing", &[]).await.unwrap_err();
        assert!(matches!(error, Error::JavaScript(_)), "{error:?}");
    }
    Ok(())
}

#[tokio::test]
async fn result_bytes_count_against_the_bridge_message_budget() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(services())
            .limits(Limits {
                bridge_message_bytes: Some(1024),
                ..limits()
            })
            .build()?;
        let mut call = Call::new("raw");
        call.json(json!(1024));
        assert_eq!(
            app.call_with(call).await?.deserialize::<Vec<u8>>()?.len(),
            1024
        );
        let mut call = Call::new("raw");
        call.json(json!(1025));
        assert!(app.call_with(call).await.is_err());
    }
    Ok(())
}

#[tokio::test]
async fn handles_carry_bytes_and_context() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(services())
            .limits(limits())
            .spawn(WorkerOptions::new(NonZeroUsize::new(1).unwrap()))
            .await?;
        let mut call = Call::new("echo");
        call.bytes(Bytes::from_static(b"-handle"));
        let output = handle.call_with(call).await?;
        assert_eq!(output.bytes_at("").unwrap(), &b"handle"[..]);
        let mut call = Call::new("caller");
        call.context(Context::new().with(Caller("bob")));
        assert_eq!(handle.call_with(call).await?.into_value(), json!("bob"));
        let raw: Vec<u8> = handle.call("raw", &2).await?;
        assert_eq!(raw, [7, 7]);
        handle.shutdown().await?;
    }
    Ok(())
}

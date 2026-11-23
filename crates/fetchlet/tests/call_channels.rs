#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Channels Rust lends to a call: JavaScript receives a channel object at
//! the argument position Rust named, and the channel closes when the call's
//! invocation ends.

use std::num::NonZeroUsize;
use std::time::Duration;

use serde_json::json;

use fetchlet::{
    App, Backend, Call, ChannelEvent, CloseFrame, Error, Limits, Message, Module, WorkerOptions,
};

const SOURCE: &str = include_str!("fixtures/call-channels.js");

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

fn app(backend: Backend, source: &str) -> anyhow::Result<App> {
    Ok(App::builder(backend)
        .module(Module::new(source))
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            ..Limits::default()
        })
        .build()?)
}

async fn next(end: &mut fetchlet::ChannelEnd) -> ChannelEvent {
    tokio::time::timeout(Duration::from_secs(10), end.recv())
        .await
        .expect("an event in time")
        .expect("an event")
}

#[tokio::test]
async fn a_nested_channel_carries_progress() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend, SOURCE)?;
        let mut call = Call::new("progress");
        call.json(json!({ "steps": 3, "progress": null }));
        let mut progress = call.channel_at("/0/progress", app.limits())?;
        let result = app.call_with(call).await?;
        assert_eq!(result, json!({ "steps": 3, "keys": ["steps", "progress"] }));
        for step in 1..=3 {
            assert_eq!(
                next(&mut progress).await,
                ChannelEvent::Message(Message::from(format!("step {step}")))
            );
        }
        assert_eq!(
            next(&mut progress).await,
            ChannelEvent::Close(CloseFrame::new(CloseFrame::NORMAL, "done"))
        );
    }
    Ok(())
}

#[tokio::test]
async fn rust_and_javascript_talk_while_the_call_runs() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend, SOURCE)?;
        let mut call = Call::new("echo");
        call.json(json!("echo:"));
        let mut channel = call.channel(app.limits());
        let talk = async {
            for word in ["a", "b"] {
                channel.send(word).await?;
                assert_eq!(
                    next(&mut channel).await,
                    ChannelEvent::Message(Message::from(format!("echo:{word}")))
                );
            }
            channel.close(CloseFrame::new(CloseFrame::NORMAL, "enough"));
            anyhow::Ok(())
        };
        let (result, talked) = tokio::join!(app.call_with(call), talk);
        talked?;
        assert_eq!(
            result?,
            json!({ "echoed": 2, "close": { "code": 1000, "reason": "enough" } })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_lent_channel_closes_when_the_call_ends() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend, SOURCE)?;
        let mut call = Call::new("leave");
        let mut channel = call.channel(app.limits());
        assert_eq!(app.call_with(call).await?, json!("returned"));
        assert_eq!(
            next(&mut channel).await,
            ChannelEvent::Message(Message::from("left open"))
        );
        assert_eq!(
            next(&mut channel).await,
            ChannelEvent::Close(CloseFrame::new(CloseFrame::ABNORMAL, ""))
        );
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test]
async fn channels_land_as_data_properties_at_their_paths() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend, SOURCE)?;
        let mut call = Call::new("shape");
        call.json(json!({ "__proto__": null }));
        call.json(json!({ "list": ["kept", null] }));
        let _first = call.channel_at("/0/__proto__", app.limits())?;
        let _second = call.channel_at("/1/list/1", app.limits())?;
        assert_eq!(
            app.call_with(call).await?,
            json!({ "first": true, "own": true, "nested": true, "kept": "kept" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn calls_lend_channels_through_a_pool() -> anyhow::Result<()> {
    for backend in backends() {
        let app = App::builder(backend)
            .module(Module::new(SOURCE))
            .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
            .await?;
        let mut call = Call::new("echo");
        call.json(json!(">"));
        let mut channel = call.channel(app.limits());
        let running = tokio::spawn({
            let app = app.clone();
            async move { app.call_with(call).await }
        });
        channel.send("x").await?;
        assert_eq!(
            next(&mut channel).await,
            ChannelEvent::Message(Message::from(">x"))
        );
        channel.close(CloseFrame::new(CloseFrame::NORMAL, ""));
        assert_eq!(running.await??["echoed"], json!(1));
        app.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn lending_needs_the_channel_views() -> anyhow::Result<()> {
    let source = "globalThis.fetchletExports = { run() { return 1; } };";
    for backend in backends() {
        let mut app = app(backend, source)?;
        let mut call = Call::new("run");
        let mut channel = call.channel(app.limits());
        let error = app.call_with(call).await.unwrap_err();
        assert!(
            matches!(&error, Error::JavaScript(message) if message.contains("Web API profile")),
            "{error}"
        );
        // The channel ended with the failed call.
        assert_eq!(
            next(&mut channel).await,
            ChannelEvent::Close(CloseFrame::new(CloseFrame::ABNORMAL, ""))
        );
        // Calls without channels need no views.
        assert_eq!(app.call_json("run", &[]).await?, json!(1));
    }
    Ok(())
}

#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Request-scoped channels: JavaScript opens a channel of a
//! `HostServices::channel` binding, which belongs to the invocation and
//! closes when it ends.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt, stream};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use fetchlet::{
    App, Backend, ChannelEnd, ChannelEvent, CloseFrame, Error, HostServices, Limits, Message,
    Module, channel_fn,
};

const SOURCE: &str = include_str!("fixtures/channels.js");

/// Messages the FLOOD service sends, each of ten bytes.
const FLOOD: usize = 100;

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

/// What the HOLD service's ends received, for the test to inspect.
type Held = mpsc::UnboundedReceiver<ChannelEvent>;

/// Echo every message, after a greeting with the open's options.
async fn echo(mut end: ChannelEnd, options: Value) {
    if end.send(format!("hello:{options}")).await.is_err() {
        return;
    }
    while let Some(event) = end.recv().await {
        match event {
            ChannelEvent::Message(Message::Text(text)) => {
                if end.send(format!("echo:{text}")).await.is_err() {
                    return;
                }
            }
            ChannelEvent::Message(message) => {
                if end.send(message).await.is_err() {
                    return;
                }
            }
            ChannelEvent::Close(frame) => {
                end.close(frame);
                return;
            }
            // Socket signals never reach a channel service.
            _ => {}
        }
    }
}

/// Answer each text message with `sink:` and the text through the end's
/// `Stream` and `Sink` halves, then close the sink when JavaScript closes.
async fn split(end: ChannelEnd) {
    let (mut sink, events) = end.split();
    let mut answers = events
        .take_while(|event| std::future::ready(matches!(event, ChannelEvent::Message(_))))
        .filter_map(|event| {
            std::future::ready(match event {
                ChannelEvent::Message(Message::Text(text)) => {
                    Some(Ok(Message::Text(format!("sink:{text}"))))
                }
                _ => None,
            })
        });
    if sink.send_all(&mut answers).await.is_ok() {
        let _ = sink.close().await;
    }
}

fn services(sent: Arc<AtomicUsize>) -> (HostServices, Held) {
    let (held_tx, held) = mpsc::unbounded_channel();
    let hosts = HostServices::new()
        .channel(
            "ECHO",
            channel_fn(|request| async move {
                tokio::spawn(echo(request.end, request.options));
                Ok(())
            }),
        )
        .unwrap()
        .channel(
            "SPLIT",
            channel_fn(|request| async move {
                tokio::spawn(split(request.end));
                Ok(())
            }),
        )
        .unwrap()
        .channel(
            "POUR",
            // FLOOD through the sink, which waits for room as send does.
            channel_fn(|request| async move {
                let mut end = request.end;
                tokio::spawn(async move {
                    let mut messages = stream::iter(
                        (0..FLOOD).map(|index| Ok(Message::from(format!("{index:010}")))),
                    );
                    if end.send_all(&mut messages).await.is_ok() {
                        let _ = SinkExt::close(&mut end).await;
                    }
                });
                Ok(())
            }),
        )
        .unwrap()
        .channel(
            "REFUSE",
            channel_fn(|_| async { Err(Error::PermissionDenied) }),
        )
        .unwrap()
        .channel(
            "HOLD",
            channel_fn(move |request| {
                let held = held_tx.clone();
                async move {
                    let mut end = request.end;
                    tokio::spawn(async move {
                        while let Some(event) = end.recv().await {
                            let _ = held.send(event);
                        }
                    });
                    Ok(())
                }
            }),
        )
        .unwrap()
        .channel(
            "DROP",
            // Keeps its end without reading, then goes away.
            channel_fn(|request| async move {
                let end = request.end;
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    drop(end);
                });
                Ok(())
            }),
        )
        .unwrap()
        .channel(
            "FLOOD",
            channel_fn(move |request| {
                let sent = sent.clone();
                async move {
                    let mut end = request.end;
                    tokio::spawn(async move {
                        for index in 0..FLOOD {
                            if end.send(format!("{index:010}")).await.is_err() {
                                return;
                            }
                            sent.fetch_add(1, Ordering::SeqCst);
                        }
                        end.close(CloseFrame::new(CloseFrame::NORMAL, "done"));
                    });
                    Ok(())
                }
            }),
        )
        .unwrap();
    (hosts, held)
}

async fn app(backend: Backend, limits: Limits) -> anyhow::Result<(App, Held, Arc<AtomicUsize>)> {
    let sent = Arc::new(AtomicUsize::new(0));
    let (hosts, held) = services(sent.clone());
    let app = App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(hosts)
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            background_timeout: Some(Duration::from_secs(10)),
            ..limits
        })
        .build()?;
    Ok((app, held, sent))
}

async fn next(held: &mut Held) -> ChannelEvent {
    tokio::time::timeout(Duration::from_secs(10), held.recv())
        .await
        .expect("an event in time")
        .expect("an event")
}

#[tokio::test]
async fn messages_cross_both_ways_and_close_with_a_handshake() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _, _) = app(backend, Limits::default()).await?;
        let result = app.call_json("echo", &[json!(["a", "b"])]).await?;
        assert_eq!(
            result,
            json!({
                "messages": [r#"hello:{"greeting":"hi"}"#, "echo:a", "echo:b", [1, 2, 3]],
                "close": { "code": 1000, "reason": "done" },
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_service_refuses_and_unknown_bindings_are_denied() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, _, _) = app(backend, Limits::default()).await?;
        assert_eq!(
            app.call_json("refused", &[]).await?,
            json!({ "refused": "host operation is not permitted", "opened": false })
        );
        assert_eq!(
            app.call_json("unknown", &[]).await?,
            json!("PERMISSION_DENIED")
        );
        // Without the Web API profile, the binding has no views to build.
        assert_eq!(
            app.call_json("env", &[]).await?,
            json!("Channels need the fetchlet Web API profile")
        );
    }
    Ok(())
}

#[tokio::test]
async fn open_channels_bounds_opens_per_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            open_channels: Some(2),
            ..Limits::default()
        };
        let (mut app, _, _) = app(backend, limits).await?;
        let codes = json!(["ok", "ok", "LIMIT_EXCEEDED"]);
        assert_eq!(app.call_json("limited", &[]).await?, codes);
        // The budget is per invocation.
        assert_eq!(app.call_json("limited", &[]).await?, codes);
    }
    Ok(())
}

#[tokio::test]
async fn a_channel_closes_when_its_invocation_ends() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, mut held, _) = app(backend, Limits::default()).await?;
        assert_eq!(app.call_json("leave", &[]).await?, json!("returned"));
        assert_eq!(
            next(&mut held).await,
            ChannelEvent::Message(Message::Text("left open".into()))
        );
        assert_eq!(
            next(&mut held).await,
            ChannelEvent::Close(CloseFrame::new(CloseFrame::ABNORMAL, ""))
        );
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test]
async fn background_work_keeps_its_channels() -> anyhow::Result<()> {
    for backend in backends() {
        let (mut app, mut held, _) = app(backend, Limits::default()).await?;
        assert_eq!(app.call_json("background", &[]).await?, json!("returned"));
        app.finish_background().await?;
        assert_eq!(
            next(&mut held).await,
            ChannelEvent::Message(Message::Text("from background".into()))
        );
        assert_eq!(
            next(&mut held).await,
            ChannelEvent::Close(CloseFrame::new(CloseFrame::ABNORMAL, ""))
        );
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test]
async fn a_write_is_split_within_the_channel_budgets() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            channel_message_bytes: Some(64),
            channel_buffer_bytes: Some(100),
            ..Limits::default()
        };
        let (mut app, _, _) = app(backend, limits).await?;
        let result = app.call_json("write", &[json!(1000)]).await?;
        assert_eq!(result["received"], json!(1000));
        // At most 64 bytes a message: at least 16 pieces.
        assert!(result["pieces"].as_u64().unwrap() >= 16, "{result}");
    }
    Ok(())
}

#[tokio::test]
async fn a_write_waiting_for_room_fails_when_rust_goes_away() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            channel_buffer_bytes: Some(100),
            ..Limits::default()
        };
        let (mut app, _, _) = app(backend, limits).await?;
        let result = app.call_json("abandonedWrite", &[json!(1000)]).await?;
        assert_eq!(
            result,
            json!({ "outcome": "The channel closed", "close": { "code": 1006, "reason": "" } })
        );
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test]
async fn a_paused_reader_holds_the_rust_sender_back() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            channel_buffer_bytes: Some(50),
            ..Limits::default()
        };
        let (mut app, _, sent) = app(backend, limits).await?;
        let result = app.call_json("paused", &[json!(false)]).await?;
        assert_eq!(result, json!({ "whilePaused": 0 }));
        // Five messages of ten bytes fill the queue; the sender waits.
        assert!(sent.load(Ordering::SeqCst) <= 5);

        sent.store(0, Ordering::SeqCst);
        let result = app.call_json("paused", &[json!(true)]).await?;
        assert_eq!(result["whilePaused"], json!(0));
        assert_eq!(result["received"], json!(FLOOD));
        assert_eq!(result["close"], json!({ "code": 1000, "reason": "done" }));
        assert_eq!(sent.load(Ordering::SeqCst), FLOOD);
    }
    Ok(())
}

#[tokio::test]
async fn ends_are_streams_and_sinks() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            channel_buffer_bytes: Some(50),
            ..Limits::default()
        };
        let (mut app, _, _) = app(backend, limits).await?;
        assert_eq!(
            app.call_json("split", &[json!(["a", "b"])]).await?,
            json!({
                "messages": ["sink:a", "sink:b"],
                "close": { "code": 1000, "reason": "" },
            })
        );
        // Five messages of ten bytes fill the queue; the sink waits for
        // room and delivers every one.
        assert_eq!(
            app.call_json("drain", &[json!("POUR")]).await?,
            json!({ "received": FLOOD, "close": { "code": 1000, "reason": "" } })
        );
    }
    Ok(())
}

#[test]
fn bindings_share_one_namespace() {
    let service = || channel_fn(|_| async { Ok(()) });
    assert!(
        HostServices::new()
            .env("NAME", "value")
            .unwrap()
            .channel("NAME", service())
            .is_err()
    );
    assert!(
        HostServices::new()
            .channel("NAME", service())
            .unwrap()
            .env("NAME", "value")
            .is_err()
    );
}

#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Server WebSockets: a Fetch handler accepts an upgrade, and its invocation
//! and instance stay held until the connection closes, within the pool's
//! `max_held_connections` and the connection budgets.

use std::num::NonZeroUsize;
use std::time::Duration;

use bytes::Bytes;

use fetchlet::{
    App, AppHandle, Backend, Body, ChannelEnd, ChannelEvent, CloseFrame, Error, Instances, Limits,
    Message, Module, ServerWebSocket, WorkerOptions,
};

const SOURCE: &str = include_str!("fixtures/websocket.js");

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

fn count(value: usize) -> NonZeroUsize {
    NonZeroUsize::new(value).unwrap()
}

fn instances(max: usize, held: usize) -> Instances {
    Instances {
        max_held_connections: held,
        ..Instances::fixed(count(max))
    }
}

async fn spawn(
    backend: Backend,
    instances: Instances,
    limits: Limits,
) -> fetchlet::Result<AppHandle> {
    let mut options = WorkerOptions::new(count(8));
    options.instances = instances;
    App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(limits)
        .spawn(options)
        .await
}

fn upgrade_request(path: &str) -> fetchlet::Request {
    http::Request::builder()
        .uri(format!("https://socket.test{path}"))
        .header("upgrade", "websocket")
        .header("connection", "upgrade")
        .body(Body::empty())
        .unwrap()
}

/// Open a connection through `handle`, with a reserved place.
async fn connect(handle: &AppHandle, path: &str) -> anyhow::Result<ChannelEnd> {
    let mut request = upgrade_request(path);
    let held = handle.reserve_connection().expect("a free place");
    request.extensions_mut().insert(held);
    let response = within("the upgrade", handle.fetch(request)).await?;
    assert_eq!(response.status(), 101);
    assert_eq!(response.headers()["sec-websocket-protocol"], "chat");
    let socket = response
        .extensions()
        .get::<ServerWebSocket>()
        .expect("an accepted upgrade");
    let end = socket.take().expect("the end");
    assert!(socket.take().is_none());
    Ok(end)
}

async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    match tokio::time::timeout(Duration::from_secs(10), future).await {
        Ok(output) => output,
        Err(_) => panic!("timed out waiting for {what}"),
    }
}

async fn next(end: &mut ChannelEnd) -> ChannelEvent {
    within("a channel event", end.recv())
        .await
        .expect("an event")
}

fn text(value: &str) -> ChannelEvent {
    ChannelEvent::Message(Message::Text(value.into()))
}

fn close(code: u16, reason: &str) -> ChannelEvent {
    ChannelEvent::Close(CloseFrame::new(code, reason))
}

/// The place of a connection returns to the pool once its invocation ends.
async fn place_returns(handle: &AppHandle) {
    within("the held place to return", async {
        loop {
            if handle.reserve_connection().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

#[tokio::test]
async fn messages_cross_both_ways_until_the_closing_handshake() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, instances(2, 1), Limits::default()).await?;
        let mut end = connect(&handle, "/greet").await?;
        // Sent from the open listener, once the handler returned.
        assert_eq!(next(&mut end).await, text("hello"));

        end.send("hi").await?;
        assert_eq!(next(&mut end).await, text("echo:hi"));
        end.send(Bytes::from_static(&[1, 2, 3])).await?;
        assert_eq!(
            next(&mut end).await,
            ChannelEvent::Message(Message::Binary(Bytes::from_static(&[3, 2, 1])))
        );
        // Timers keep running in the held invocation.
        end.send("later").await?;
        assert_eq!(next(&mut end).await, text("timer"));

        // JavaScript closes; Rust answers, as the HTTP integration does.
        end.send("close").await?;
        assert_eq!(next(&mut end).await, close(4000, "bye"));
        end.close(CloseFrame::new(4000, "bye"));
        assert!(end.recv().await.is_none());
        place_returns(&handle).await;
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn other_instances_serve_requests_while_a_connection_is_held() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, instances(2, 1), Limits::default()).await?;
        let mut end = connect(&handle, "/echo").await?;
        for _ in 0..3 {
            assert_eq!(
                within("a call", handle.call_json("ping", &[])).await?,
                "pong"
            );
        }
        end.send("still").await?;
        assert_eq!(next(&mut end).await, text("echo:still"));

        // Rust closes; JavaScript answers with the same frame.
        end.close(CloseFrame::new(CloseFrame::NORMAL, "done"));
        assert_eq!(next(&mut end).await, close(CloseFrame::NORMAL, "done"));
        place_returns(&handle).await;
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn a_peer_that_goes_away_ends_the_invocation() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, instances(2, 1), Limits::default()).await?;
        let end = connect(&handle, "/echo").await?;
        assert!(handle.reserve_connection().is_none());
        drop(end);
        place_returns(&handle).await;
        // Both instances are free again.
        let mut again = connect(&handle, "/echo").await?;
        again.send("again").await?;
        assert_eq!(next(&mut again).await, text("echo:again"));
        drop(again);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn an_upgrade_needs_a_place_and_an_upgrade_request() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, instances(2, 1), Limits::default()).await?;
        // Without a reserved place, JavaScript cannot accept the upgrade.
        let response = handle.fetch(upgrade_request("/echo")).await?;
        assert_eq!(response.status(), 426);
        assert_eq!(response.headers()["x-error"], "PERMISSION_DENIED");

        // A place on a request that does not ask for an upgrade does nothing.
        let mut request = http::Request::builder()
            .uri("https://socket.test/echo")
            .body(Body::empty())?;
        request
            .extensions_mut()
            .insert(handle.reserve_connection().unwrap());
        assert_eq!(handle.fetch(request).await?.status(), 200);
        place_returns(&handle).await;

        // An accepted socket the handler does not return ends with it.
        let mut request = upgrade_request("/decline");
        request
            .extensions_mut()
            .insert(handle.reserve_connection().unwrap());
        let response = handle.fetch(request).await?;
        assert_eq!(response.status(), 200);
        assert!(response.extensions().get::<ServerWebSocket>().is_none());
        place_returns(&handle).await;

        // An App runs requests without held connections.
        let mut app = App::builder(backend).module(Module::new(SOURCE)).build()?;
        let mut request = upgrade_request("/echo");
        request
            .extensions_mut()
            .insert(handle.reserve_connection().unwrap());
        assert_eq!(app.fetch(request).await?.status(), 426);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn held_connections_stay_below_the_pool_size() -> anyhow::Result<()> {
    for backend in backends() {
        for (max, held) in [(1, 1), (2, 2), (2, 3)] {
            assert!(matches!(
                spawn(backend, instances(max, held), Limits::default()).await,
                Err(Error::Configuration(_))
            ));
        }
        let handle = spawn(backend, Instances::fixed(count(2)), Limits::default()).await?;
        // The default holds none.
        assert!(handle.reserve_connection().is_none());
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn budgets_close_a_held_connection() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            connection_idle_timeout: Some(Duration::from_millis(300)),
            ..Limits::default()
        };
        let handle = spawn(backend, instances(2, 1), limits).await?;
        let mut end = connect(&handle, "/echo").await?;
        end.send("ping").await?;
        assert_eq!(next(&mut end).await, text("echo:ping"));
        assert_eq!(
            next(&mut end).await,
            close(CloseFrame::GOING_AWAY, "idle timeout")
        );
        place_returns(&handle).await;
        handle.shutdown().await?;

        let limits = Limits {
            connection_lifetime: Some(Duration::from_millis(300)),
            ..Limits::default()
        };
        let handle = spawn(backend, instances(2, 1), limits).await?;
        let mut end = connect(&handle, "/echo").await?;
        assert_eq!(
            next(&mut end).await,
            close(CloseFrame::GOING_AWAY, "connection lifetime")
        );
        place_returns(&handle).await;
        handle.shutdown().await?;

        let limits = Limits {
            channel_message_bytes: Some(16),
            ..Limits::default()
        };
        let handle = spawn(backend, instances(2, 1), limits).await?;
        let mut end = connect(&handle, "/echo").await?;
        assert!(matches!(
            end.send("x".repeat(17)).await,
            Err(Error::LimitExceeded("channel message bytes"))
        ));
        // JavaScript's message over the budget closes the channel.
        end.send("big").await?;
        assert_eq!(
            next(&mut end).await,
            close(
                CloseFrame::MESSAGE_TOO_BIG,
                "message exceeds the channel budget"
            )
        );
        place_returns(&handle).await;
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn shutdown_closes_held_connections() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, instances(2, 1), Limits::default()).await?;
        let mut end = connect(&handle, "/echo").await?;
        let stopping = handle.clone();
        let shutdown = tokio::spawn(async move { stopping.shutdown().await });
        assert_eq!(
            next(&mut end).await,
            close(CloseFrame::GOING_AWAY, "the server is shutting down")
        );
        within("shutdown", shutdown).await??;
    }
    Ok(())
}

#[tokio::test]
async fn javascript_sees_how_much_it_has_buffered() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend, instances(2, 1), Limits::default()).await?;
        let mut end = connect(&handle, "/echo").await?;
        // Rust has received everything JavaScript sent before.
        end.send("buffered").await?;
        assert_eq!(next(&mut end).await, text("0"));
        drop(end);
        handle.shutdown().await?;
    }
    Ok(())
}

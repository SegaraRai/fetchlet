#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Client WebSockets: JavaScript opens a `ws:` or `wss:` URL through a
//! `WebSocketService`, whose policy authorizes its origin and whose
//! transport performs the handshake and carries the messages over a channel
//! of the invocation.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::mpsc;

use fetchlet::http::{HeaderValue, header};
use fetchlet::{
    App, Backend, ChannelEnd, ChannelEvent, CloseFrame, Error, FetchPolicy, HostServices, Limits,
    Message, Module, WebSocketAccept, WebSocketService, websocket_fn,
};

const SOURCE: &str = include_str!("fixtures/websocket-client.js");

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

/// Answer text with `echo:` and the text, bytes with the same bytes, and a
/// close with the same close, as a server's closing handshake does.
async fn echo(mut end: ChannelEnd) {
    while let Some(event) = end.recv().await {
        match event {
            ChannelEvent::Message(Message::Text(text)) => {
                if end.send(format!("echo:{text}")).await.is_err() {
                    return;
                }
            }
            ChannelEvent::Message(Message::Binary(bytes)) => {
                if end.send(bytes).await.is_err() {
                    return;
                }
            }
            ChannelEvent::Close(frame) => {
                end.close(frame);
                return;
            }
            _ => {}
        }
    }
}

/// Each URL the transport saw, with its authorization header.
type Requests = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// What the transport saw, and what a held end received.
struct Seen {
    requests: Requests,
    held: mpsc::UnboundedReceiver<ChannelEvent>,
}

fn service() -> anyhow::Result<(WebSocketService, Seen)> {
    let requests: Requests = Arc::new(Mutex::new(Vec::new()));
    let (held_tx, held) = mpsc::unbounded_channel();
    let seen = requests.clone();
    let transport = websocket_fn(move |request| {
        let held = held_tx.clone();
        let authorization = request
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        seen.lock()
            .unwrap()
            .push((request.url.to_string(), authorization));
        async move {
            let mut end = request.end;
            let selected = WebSocketAccept {
                protocol: request.protocols.last().cloned().unwrap_or_default(),
                extensions: String::new(),
            };
            match request.url.host_str() {
                Some("refused.test") => Err(Error::Transport("handshake failed".into())),
                Some("hold.test") => {
                    tokio::spawn(async move {
                        while let Some(event) = end.recv().await {
                            let _ = held.send(event);
                        }
                    });
                    Ok(selected)
                }
                Some("greeter.test") => {
                    tokio::spawn(async move {
                        if end.send("hello").await.is_ok() {
                            end.close(CloseFrame::new(CloseFrame::GOING_AWAY, "bye"));
                        }
                    });
                    Ok(selected)
                }
                Some("broken.test") => {
                    // The connection ends without a closing handshake.
                    tokio::spawn(async move {
                        let _ = end.send("partial").await;
                        drop(end);
                    });
                    Ok(selected)
                }
                _ => {
                    tokio::spawn(echo(end));
                    Ok(selected)
                }
            }
        }
    });
    let policy = FetchPolicy::deny_all()
        .allow_origin("https://chat.test")?
        .allow_origin("http://plain.test")?
        .allow_origin("https://refused.test")?
        .allow_origin("https://hold.test")?
        .allow_origin("https://greeter.test")?
        .allow_origin("https://broken.test")?;
    let service = WebSocketService::new(transport, policy)
        .rewrite(|url| {
            // JavaScript knows the chat server by a name the host maps.
            if url.host_str() == Some("chat") {
                url.set_host(Some("chat.test"))
                    .map_err(|_| Error::InvalidRequest("bad host".into()))?;
            }
            Ok(())
        })
        .credentials(|url, headers| {
            if url.host_str() == Some("chat.test") {
                headers.insert(
                    header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer chat"),
                );
            }
            Ok(())
        });
    Ok((service, Seen { requests, held }))
}

fn app(backend: Backend, hosts: HostServices, limits: Limits) -> anyhow::Result<App> {
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(hosts)
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            ..limits
        })
        .build()?)
}

fn websockets(service: WebSocketService) -> HostServices {
    HostServices::new().websockets(service)
}

#[tokio::test]
async fn messages_cross_both_ways_after_rewrite_policy_and_credentials() -> anyhow::Result<()> {
    for backend in backends() {
        let (service, seen) = service()?;
        let mut app = app(backend, websockets(service), Limits::default())?;
        assert_eq!(
            app.call_json(
                "exchange",
                &[
                    json!("wss://chat/room?id=1"),
                    json!(["v1", "v2"]),
                    json!("hi")
                ]
            )
            .await?,
            json!({
                "accepted": { "protocol": "v2", "extensions": "" },
                "messages": ["echo:hi", [1, 2, 3]],
                "close": { "code": 1000, "reason": "done" },
            })
        );
        assert_eq!(
            app.call_json(
                "exchange",
                &[json!("ws://plain.test/"), json!([]), json!("x")]
            )
            .await?["accepted"],
            json!({ "protocol": "", "extensions": "" })
        );
        assert_eq!(
            *seen.requests.lock().unwrap(),
            vec![
                (
                    "wss://chat.test/room?id=1".to_owned(),
                    Some("Bearer chat".to_owned())
                ),
                ("ws://plain.test/".to_owned(), None),
            ]
        );
    }
    Ok(())
}

#[tokio::test]
async fn the_policy_and_a_missing_service_refuse_at_once() -> anyhow::Result<()> {
    for backend in backends() {
        let (service, seen) = service()?;
        let mut app = app(backend, websockets(service), Limits::default())?;
        // ws: and wss: count as http: and https: for the policy.
        for url in [
            "wss://elsewhere.test/",
            "ws://chat.test/",
            "wss://plain.test/",
        ] {
            assert_eq!(
                app.call_json("code", &[json!(url)]).await?,
                json!("PERMISSION_DENIED"),
                "{url}"
            );
        }
        for (url, protocols) in [
            ("https://chat.test/", json!([])),
            ("wss://chat.test/#top", json!([])),
            ("not a url", json!([])),
            ("wss://chat.test/", json!(["a b"])),
            ("wss://chat.test/", json!(["v1", "v1"])),
        ] {
            assert_eq!(
                app.call_json("code", &[json!(url), protocols]).await?,
                json!("INVALID_REQUEST"),
                "{url}"
            );
        }
        // Refused URLs never reach the transport.
        assert!(seen.requests.lock().unwrap().is_empty());
    }
    for backend in backends() {
        let mut app = app(backend, HostServices::new(), Limits::default())?;
        assert_eq!(
            app.call_json("code", &[json!("wss://chat.test/")]).await?,
            json!("PERMISSION_DENIED")
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_handshake_is_refused() -> anyhow::Result<()> {
    for backend in backends() {
        let (service, _) = service()?;
        let mut app = app(backend, websockets(service), Limits::default())?;
        assert_eq!(
            app.call_json("drain", &[json!("wss://refused.test/")])
                .await?,
            json!({
                "opened": false,
                "messages": [],
                "close": null,
                "refused": "host transport failed",
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn the_server_closes_cleanly_or_the_connection_drops() -> anyhow::Result<()> {
    for backend in backends() {
        let (service, _) = service()?;
        let mut app = app(backend, websockets(service), Limits::default())?;
        assert_eq!(
            app.call_json("drain", &[json!("wss://greeter.test/")])
                .await?,
            json!({
                "opened": true,
                "messages": ["hello"],
                "close": { "code": 1001, "reason": "bye" },
                "refused": null,
            })
        );
        assert_eq!(
            app.call_json("drain", &[json!("wss://broken.test/")])
                .await?,
            json!({
                "opened": true,
                "messages": ["partial"],
                "close": { "code": 1006, "reason": "" },
                "refused": null,
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_websocket_closes_when_its_invocation_ends() -> anyhow::Result<()> {
    for backend in backends() {
        let (service, mut seen) = service()?;
        let mut app = app(backend, websockets(service), Limits::default())?;
        assert_eq!(
            app.call_json("leave", &[json!("wss://hold.test/")]).await?,
            json!("returned")
        );
        let event = tokio::time::timeout(Duration::from_secs(10), seen.held.recv())
            .await?
            .expect("an event");
        assert_eq!(event, ChannelEvent::Message(Message::from("left open")));
        let event = tokio::time::timeout(Duration::from_secs(10), seen.held.recv())
            .await?
            .expect("an event");
        assert_eq!(
            event,
            ChannelEvent::Close(CloseFrame::new(CloseFrame::ABNORMAL, ""))
        );
        assert!(app.is_reusable());
    }
    Ok(())
}

#[tokio::test]
async fn websockets_count_against_open_channels() -> anyhow::Result<()> {
    for backend in backends() {
        let (service, seen) = service()?;
        let limits = Limits {
            open_channels: Some(0),
            ..Limits::default()
        };
        let mut app = app(backend, websockets(service), limits)?;
        assert_eq!(
            app.call_json("code", &[json!("wss://chat.test/")]).await?,
            json!("LIMIT_EXCEEDED")
        );
        assert!(seen.requests.lock().unwrap().is_empty());
    }
    Ok(())
}

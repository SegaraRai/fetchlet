#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Sockets: JavaScript connects to an address through a `SocketService`,
//! whose policy authorizes it and whose transport carries the bytes over a
//! channel of the invocation.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use fetchlet::{
    App, Backend, ChannelEnd, ChannelEvent, CloseFrame, Error, HostServices, Limits, Message,
    Module, SecureTransport, SocketPolicy, SocketService, socket_fn,
};

const SOURCE: &str = include_str!("fixtures/sockets.js");

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

/// Answer each write with `<address>:<tls>:` and the bytes written.
async fn echo(mut end: ChannelEnd, prefix: String) {
    while let Some(event) = end.recv().await {
        match event {
            ChannelEvent::Message(Message::Binary(bytes)) => {
                let mut reply = prefix.clone().into_bytes();
                reply.extend_from_slice(&bytes);
                if end.send(reply).await.is_err() {
                    return;
                }
            }
            ChannelEvent::Message(Message::Text(_)) => {}
            ChannelEvent::Close(frame) => {
                end.close(frame);
                return;
            }
        }
    }
}

/// The addresses the transport saw, and what a held end received.
struct Seen {
    addresses: Arc<Mutex<Vec<String>>>,
    held: mpsc::UnboundedReceiver<ChannelEvent>,
}

fn service() -> anyhow::Result<(SocketService, Seen)> {
    let addresses = Arc::new(Mutex::new(Vec::new()));
    let (held_tx, held) = mpsc::unbounded_channel();
    let seen = addresses.clone();
    let transport = socket_fn(move |request| {
        let held = held_tx.clone();
        seen.lock().unwrap().push(request.address.to_string());
        async move {
            let address = request.address;
            let mut end = request.end;
            match (address.host(), address.port()) {
                ("refused.test", _) => Err(Error::Transport("connection refused".into())),
                ("hold.test", _) => {
                    tokio::spawn(async move {
                        while let Some(event) = end.recv().await {
                            let _ = held.send(event);
                        }
                    });
                    Ok(())
                }
                ("greeter.test", _) => {
                    tokio::spawn(async move {
                        if end.send(b"hello".to_vec()).await.is_ok() {
                            end.close(CloseFrame::new(CloseFrame::NORMAL, ""));
                        }
                    });
                    Ok(())
                }
                ("broken.test", _) => {
                    tokio::spawn(async move {
                        if end.send(b"partial".to_vec()).await.is_ok() {
                            end.close(CloseFrame::new(
                                CloseFrame::INTERNAL_ERROR,
                                "connection reset",
                            ));
                        }
                    });
                    Ok(())
                }
                _ => {
                    let tls = match request.secure_transport {
                        SecureTransport::Off => "plain",
                        SecureTransport::On => "tls",
                    };
                    tokio::spawn(echo(end, format!("{address}:{tls}:")));
                    Ok(())
                }
            }
        }
    });
    let policy = SocketPolicy::deny_all()
        .allow("db.internal", 5432)?
        .allow_ports("::1", 6000..=6010)?
        .allow("refused.test", 80)?
        .allow("hold.test", 80)?
        .allow("greeter.test", 80)?
        .allow("broken.test", 80)?;
    let service = SocketService::new(transport, policy).rewrite(|address| {
        // JavaScript knows the database by a name the host maps.
        if address.host() == "db" {
            *address = fetchlet::SocketAddress::new("db.internal", address.port())?;
        }
        Ok(())
    });
    Ok((service, Seen { addresses, held }))
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

fn args(values: &[Value]) -> Vec<Value> {
    values.to_vec()
}

#[tokio::test]
async fn bytes_cross_both_ways_after_rewrite_and_policy() -> anyhow::Result<()> {
    for backend in backends() {
        let (sockets, seen) = service()?;
        let mut app = app(
            backend,
            HostServices::new().sockets(sockets),
            Limits::default(),
        )?;
        let result = app
            .call_json(
                "exchange",
                &args(&[
                    json!("db"),
                    json!(5432),
                    json!("ping"),
                    json!(25),
                    json!("off"),
                ]),
            )
            .await?;
        assert_eq!(
            result,
            json!({
                "received": "db.internal:5432:plain:ping",
                "close": { "code": 1000, "reason": "" },
            })
        );
        let result = app
            .call_json(
                "exchange",
                &args(&[
                    json!("0:0::1"),
                    json!(6001),
                    json!("x"),
                    json!(15),
                    json!("on"),
                ]),
            )
            .await?;
        assert_eq!(result["received"], json!("[::1]:6001:tls:x"));
        assert_eq!(
            *seen.addresses.lock().unwrap(),
            vec!["db.internal:5432", "[::1]:6001"]
        );
    }
    Ok(())
}

#[tokio::test]
async fn the_policy_and_a_missing_service_refuse_at_once() -> anyhow::Result<()> {
    for backend in backends() {
        let (sockets, seen) = service()?;
        let mut app = app(
            backend,
            HostServices::new().sockets(sockets),
            Limits::default(),
        )?;
        for (host, port) in [("db.internal", 5433), ("elsewhere.test", 80), ("::1", 6011)] {
            assert_eq!(
                app.call_json("code", &args(&[json!(host), json!(port), json!("off")]))
                    .await?,
                json!("PERMISSION_DENIED"),
                "{host}:{port}"
            );
        }
        for (host, port, tls) in [
            ("bad host", 80, "off"),
            ("db.internal", 0, "off"),
            ("db.internal", 5432, "starttls"),
        ] {
            assert_eq!(
                app.call_json("code", &args(&[json!(host), json!(port), json!(tls)]))
                    .await?,
                json!("INVALID_REQUEST"),
                "{host}:{port}:{tls}"
            );
        }
        // Refused addresses never reach the transport.
        assert!(seen.addresses.lock().unwrap().is_empty());
    }
    for backend in backends() {
        let mut app = app(backend, HostServices::new(), Limits::default())?;
        assert_eq!(
            app.call_json(
                "code",
                &args(&[json!("db.internal"), json!(5432), json!("off")])
            )
            .await?,
            json!("PERMISSION_DENIED")
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_connect_is_refused() -> anyhow::Result<()> {
    for backend in backends() {
        let (sockets, _) = service()?;
        let mut app = app(
            backend,
            HostServices::new().sockets(sockets),
            Limits::default(),
        )?;
        assert_eq!(
            app.call_json(
                "refused",
                &args(&[json!("refused.test"), json!(80), json!("off")])
            )
            .await?,
            json!({ "opened": false, "refused": "host transport failed" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn the_peer_closes_normally_or_with_an_error() -> anyhow::Result<()> {
    for backend in backends() {
        let (sockets, _) = service()?;
        let mut app = app(
            backend,
            HostServices::new().sockets(sockets),
            Limits::default(),
        )?;
        assert_eq!(
            app.call_json("drain", &args(&[json!("greeter.test"), json!(80)]))
                .await?,
            json!({
                "received": "hello",
                "close": { "code": 1000, "reason": "" },
                "refused": null,
            })
        );
        assert_eq!(
            app.call_json("drain", &args(&[json!("broken.test"), json!(80)]))
                .await?,
            json!({
                "received": "partial",
                "close": { "code": 1011, "reason": "connection reset" },
                "refused": null,
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_socket_closes_when_its_invocation_ends() -> anyhow::Result<()> {
    for backend in backends() {
        let (sockets, mut seen) = service()?;
        let mut app = app(
            backend,
            HostServices::new().sockets(sockets),
            Limits::default(),
        )?;
        assert_eq!(
            app.call_json("leave", &args(&[json!("hold.test"), json!(80)]))
                .await?,
            json!("returned")
        );
        let event = tokio::time::timeout(Duration::from_secs(10), seen.held.recv())
            .await?
            .expect("an event");
        assert_eq!(
            event,
            ChannelEvent::Message(Message::Binary(b"left open".to_vec().into()))
        );
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
async fn sockets_count_against_open_channels() -> anyhow::Result<()> {
    for backend in backends() {
        let (sockets, _) = service()?;
        let limits = Limits {
            open_channels: Some(0),
            ..Limits::default()
        };
        let mut app = app(backend, HostServices::new().sockets(sockets), limits)?;
        assert_eq!(
            app.call_json(
                "code",
                &args(&[json!("db.internal"), json!(5432), json!("off")])
            )
            .await?,
            json!("LIMIT_EXCEEDED")
        );
    }
    Ok(())
}

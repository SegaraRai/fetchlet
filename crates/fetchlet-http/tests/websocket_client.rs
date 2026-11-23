//! WebSocketClient: JavaScript's WebSockets reach WebSocket servers, within
//! the address checks of the transport and the policy of its service.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use fetchlet::{App, Backend, FetchPolicy, HostServices, Limits, Module, WebSocketService};
use fetchlet_http::WebSocketClient;
use fetchlet_http::rustls::{self, ClientConfig, RootCertStore, ServerConfig};

const SOURCE: &str = include_str!("fixtures/websocket-client.js");

fn backends() -> Vec<Backend> {
    vec![Backend::quickjs(), Backend::boa(), Backend::v8()]
}

/// What a test server does once the handshake succeeds.
#[derive(Clone, Copy)]
enum Behavior {
    /// Answer text with `echo:` and the text and bytes with the same bytes.
    Echo,
    /// Send `hello`, then close with 1001.
    Greet,
    /// Send a text message of 64 bytes.
    Large,
}

/// Accept a WebSocket over `stream`, selecting `v2` when the client asks
/// for it, then behave as `behavior` says.
async fn serve<S>(stream: S, behavior: Behavior)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // tungstenite's callback type fixes the size of its error.
    #[allow(clippy::result_large_err)]
    let select = |request: &Request, mut response: Response| {
        let requested = request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if requested.split(", ").any(|protocol| protocol == "v2") {
            response
                .headers_mut()
                .insert("sec-websocket-protocol", HeaderValue::from_static("v2"));
        }
        Ok(response)
    };
    let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, select).await else {
        return;
    };
    match behavior {
        Behavior::Echo => {}
        Behavior::Greet => {
            let _ = socket.send(WsMessage::text("hello")).await;
            let _ = socket
                .close(Some(CloseFrame {
                    code: CloseCode::Away,
                    reason: "bye".into(),
                }))
                .await;
        }
        Behavior::Large => {
            let _ = socket.send(WsMessage::text("x".repeat(64))).await;
        }
    }
    // tungstenite answers the client's close; reading on completes it.
    while let Some(Ok(message)) = socket.next().await {
        let reply = match message {
            WsMessage::Text(text) => WsMessage::text(format!("echo:{text}")),
            WsMessage::Binary(bytes) => WsMessage::Binary(bytes),
            _ => continue,
        };
        if matches!(behavior, Behavior::Echo) && socket.send(reply).await.is_err() {
            return;
        }
    }
}

/// A plain WebSocket server on loopback.
async fn server(behavior: Behavior) -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(stream, behavior));
        }
    });
    Ok(port)
}

/// A WebSocket server over TLS with the test certificate.
async fn tls_server() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let acceptor = acceptor()?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(stream) = acceptor.accept(stream).await {
                    serve(stream, Behavior::Echo).await;
                }
            });
        }
    });
    Ok(port)
}

/// A TCP server that closes each connection without a handshake.
async fn closing_server() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move { while listener.accept().await.is_ok() {} });
    Ok(port)
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Serve TLS with the test certificate for `localhost` and `127.0.0.1`.
fn acceptor() -> anyhow::Result<TlsAcceptor> {
    let certificate = CertificateDer::from(include_bytes!("fixtures/tls/server.der").to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        include_bytes!("fixtures/tls/server.key.der").to_vec(),
    ));
    let config = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// A client that trusts the test certificate authority.
fn trusting() -> anyhow::Result<WebSocketClient> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(
        include_bytes!("fixtures/tls/ca.der").to_vec(),
    ))?;
    let config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(WebSocketClient::with_tls_config(Arc::new(config)).allow_private_addresses())
}

fn app(
    backend: Backend,
    client: WebSocketClient,
    origin: &str,
    limits: Limits,
) -> anyhow::Result<App> {
    let policy = FetchPolicy::deny_all().allow_origin(origin)?;
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().websockets(WebSocketService::new(client, policy)))
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            ..limits
        })
        .build()?)
}

fn loopback() -> WebSocketClient {
    WebSocketClient::new().allow_private_addresses()
}

async fn exchange(app: &mut App, url: &str) -> anyhow::Result<Value> {
    Ok(app
        .call_json("exchange", &[json!(url), json!(["v1", "v2"]), json!("hi")])
        .await?)
}

#[tokio::test]
async fn messages_reach_a_websocket_server_and_back() -> anyhow::Result<()> {
    let port = server(Behavior::Echo).await?;
    for backend in backends() {
        let mut app = app(
            backend,
            loopback(),
            &format!("http://127.0.0.1:{port}"),
            Limits::default(),
        )?;
        assert_eq!(
            exchange(&mut app, &format!("ws://127.0.0.1:{port}/chat")).await?,
            json!({
                "accepted": { "protocol": "v2", "extensions": "" },
                "messages": ["echo:hi", [1, 2, 3]],
                "close": { "code": 1000, "reason": "done" },
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn wss_verifies_the_server_and_carries_messages() -> anyhow::Result<()> {
    let port = tls_server().await?;
    for backend in backends() {
        let mut app = app(
            backend,
            trusting()?,
            &format!("https://127.0.0.1:{port}"),
            Limits::default(),
        )?;
        assert_eq!(
            exchange(&mut app, &format!("wss://127.0.0.1:{port}/")).await?["messages"],
            json!(["echo:hi", [1, 2, 3]])
        );
    }
    for backend in backends() {
        // The webpki roots do not include the test authority.
        let mut app = app(
            backend,
            loopback(),
            &format!("https://127.0.0.1:{port}"),
            Limits::default(),
        )?;
        assert_eq!(
            exchange(&mut app, &format!("wss://127.0.0.1:{port}/")).await?,
            json!({ "refused": "host transport failed" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn the_server_closing_closes_the_websocket() -> anyhow::Result<()> {
    let port = server(Behavior::Greet).await?;
    for backend in backends() {
        let mut app = app(
            backend,
            loopback(),
            &format!("http://127.0.0.1:{port}"),
            Limits::default(),
        )?;
        assert_eq!(
            app.call_json("drain", &[json!(format!("ws://127.0.0.1:{port}/"))])
                .await?,
            json!({
                "opened": true,
                "messages": ["hello"],
                "close": { "code": 1001, "reason": "bye" },
                "refused": null,
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_message_over_the_limit_closes_with_1009() -> anyhow::Result<()> {
    let port = server(Behavior::Large).await?;
    for backend in backends() {
        let limits = Limits {
            channel_message_bytes: Some(16),
            ..Limits::default()
        };
        let mut app = app(
            backend,
            loopback(),
            &format!("http://127.0.0.1:{port}"),
            limits,
        )?;
        assert_eq!(
            app.call_json("drain", &[json!(format!("ws://127.0.0.1:{port}/"))])
                .await?["close"],
            json!({ "code": 1009, "reason": "message too big" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn private_addresses_are_refused_unless_allowed() -> anyhow::Result<()> {
    let port = server(Behavior::Echo).await?;
    for backend in backends() {
        // The policy allows the origin; the client refuses where it leads.
        let mut app = app(
            backend,
            WebSocketClient::new(),
            &format!("http://localhost:{port}"),
            Limits::default(),
        )?;
        assert_eq!(
            exchange(&mut app, &format!("ws://localhost:{port}/")).await?,
            json!({ "refused": "host operation is not permitted" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_server_without_websockets_fails_the_handshake() -> anyhow::Result<()> {
    let port = closing_server().await?;
    for backend in backends() {
        let mut app = app(
            backend,
            loopback(),
            &format!("http://127.0.0.1:{port}"),
            Limits::default(),
        )?;
        assert_eq!(
            exchange(&mut app, &format!("ws://127.0.0.1:{port}/")).await?,
            json!({ "refused": "host transport failed" })
        );
    }
    Ok(())
}

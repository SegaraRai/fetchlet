//! TcpTransport: JavaScript's sockets reach TCP servers, within the address
//! checks of the transport and the policy of its service.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use fetchlet::{App, Backend, HostServices, Limits, Module, SocketPolicy, SocketService};
use fetchlet_net::TcpTransport;
use fetchlet_net::rustls::{self, ClientConfig, RootCertStore, ServerConfig};

const SOURCE: &str = include_str!("fixtures/sockets.js");

fn backends() -> Vec<Backend> {
    vec![Backend::quickjs(), Backend::boa(), Backend::v8()]
}

/// A server that answers each connection's first read with `reply` and the
/// bytes read, then closes when `close`, or echoes until the client closes.
async fn server(reply: &'static str, close: bool) -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0; 1024];
                let mut first = true;
                loop {
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    if first {
                        let _ = stream.write_all(reply.as_bytes()).await;
                        first = false;
                    }
                    let _ = stream.write_all(&buffer[..read]).await;
                    if close {
                        return;
                    }
                }
            });
        }
    });
    Ok(port)
}

fn app(backend: Backend, transport: TcpTransport, policy: SocketPolicy) -> anyhow::Result<App> {
    Ok(App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().sockets(SocketService::new(transport, policy)))
        .limits(Limits {
            timeout: Some(Duration::from_secs(10)),
            ..Limits::default()
        })
        .build()?)
}

fn loopback(port: u16) -> anyhow::Result<(TcpTransport, SocketPolicy)> {
    Ok((
        TcpTransport::new().allow_private_addresses(),
        SocketPolicy::deny_all().allow("127.0.0.1", port)?,
    ))
}

async fn exchange(
    app: &mut App,
    host: &str,
    port: u16,
    secure_transport: &str,
    message: &str,
    expected: usize,
) -> anyhow::Result<Value> {
    Ok(app
        .call_json(
            "exchange",
            &[
                json!(host),
                json!(port),
                json!(secure_transport),
                json!(message),
                json!(expected),
            ],
        )
        .await?)
}

#[tokio::test]
async fn bytes_reach_a_tcp_server_and_back() -> anyhow::Result<()> {
    let port = server("echo:", false).await?;
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            exchange(&mut app, "127.0.0.1", port, "off", "ping", 9).await?,
            json!({ "received": "echo:ping", "close": { "code": 1000, "reason": "" } })
        );
    }
    Ok(())
}

#[tokio::test]
async fn the_server_closing_ends_the_socket() -> anyhow::Result<()> {
    let port = server("bye:", true).await?;
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            exchange(&mut app, "127.0.0.1", port, "off", "x", 1000).await?,
            json!({ "received": "bye:x", "close": { "code": 1000, "reason": "" } })
        );
    }
    Ok(())
}

#[tokio::test]
async fn private_addresses_are_refused_unless_allowed() -> anyhow::Result<()> {
    let port = server("echo:", false).await?;
    for backend in backends() {
        // The policy allows both names; the transport refuses where they lead.
        let policy = SocketPolicy::deny_all()
            .allow("127.0.0.1", port)?
            .allow("localhost", port)?;
        let mut app = app(backend, TcpTransport::new(), policy)?;
        for host in ["127.0.0.1", "localhost"] {
            assert_eq!(
                exchange(&mut app, host, port, "off", "ping", 9).await?,
                json!({ "refused": "host operation is not permitted" }),
                "{host}"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn tls_with_a_plain_server_fails_to_open() -> anyhow::Result<()> {
    let port = server("not tls", true).await?;
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            exchange(&mut app, "127.0.0.1", port, "on", "ping", 9).await?,
            json!({ "refused": "host transport failed" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_closed_port_fails_to_open() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            exchange(&mut app, "127.0.0.1", port, "off", "ping", 9).await?,
            json!({ "refused": "host transport failed" })
        );
    }
    Ok(())
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

/// A transport that trusts the test certificate authority.
fn trusting() -> anyhow::Result<TcpTransport> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(
        include_bytes!("fixtures/tls/ca.der").to_vec(),
    ))?;
    let config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(TcpTransport::with_tls_config(Arc::new(config)).allow_private_addresses())
}

/// Answer the first read with `tls:` and the bytes read, then echo.
async fn echo_tls<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S) {
    let mut buffer = [0; 1024];
    let mut first = true;
    while let Ok(read) = stream.read(&mut buffer).await {
        if read == 0 {
            return;
        }
        if first {
            let _ = stream.write_all(b"tls:").await;
            first = false;
        }
        // TLS may hold accepted bytes until a flush.
        if stream.write_all(&buffer[..read]).await.is_err() || stream.flush().await.is_err() {
            return;
        }
    }
}

/// A server that speaks TLS from the start, or after a plain `STARTTLS`
/// line answered with `GO` when `start_tls`.
async fn tls_server(start_tls: bool) -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let acceptor = acceptor()?;
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if start_tls {
                    // The client sends nothing after its line until it
                    // starts TLS, so the buffer holds no TLS bytes.
                    let mut line = String::new();
                    let mut reader = BufReader::new(&mut stream);
                    if reader.read_line(&mut line).await.is_err() || line != "STARTTLS\n" {
                        return;
                    }
                    if stream.write_all(b"GO\n").await.is_err() {
                        return;
                    }
                }
                if let Ok(stream) = acceptor.accept(stream).await {
                    echo_tls(stream).await;
                }
            });
        }
    });
    Ok(port)
}

/// A server that reads until the client ends its writes, then answers with
/// `got:` and what it read and closes.
async fn collecting_server() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut collected = Vec::new();
                if stream.read_to_end(&mut collected).await.is_err() {
                    return;
                }
                let _ = stream.write_all(b"got:").await;
                let _ = stream.write_all(&collected).await;
            });
        }
    });
    Ok(port)
}

async fn start_tls(app: &mut App, port: u16) -> anyhow::Result<Value> {
    Ok(app
        .call_json(
            "startTls",
            &[json!("127.0.0.1"), json!(port), json!("hello"), json!(9)],
        )
        .await?)
}

#[tokio::test]
async fn tls_verifies_the_server_and_carries_bytes() -> anyhow::Result<()> {
    let port = tls_server(false).await?;
    for backend in backends() {
        let policy = SocketPolicy::deny_all().allow("127.0.0.1", port)?;
        let mut app = app(backend, trusting()?, policy)?;
        assert_eq!(
            exchange(&mut app, "127.0.0.1", port, "on", "ping", 8).await?,
            json!({ "received": "tls:ping", "close": { "code": 1000, "reason": "" } })
        );
    }
    Ok(())
}

#[tokio::test]
async fn tls_refuses_a_server_it_does_not_trust() -> anyhow::Result<()> {
    let port = tls_server(false).await?;
    for backend in backends() {
        // The webpki roots do not include the test authority.
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            exchange(&mut app, "127.0.0.1", port, "on", "ping", 8).await?,
            json!({ "refused": "host transport failed" })
        );
    }
    Ok(())
}

#[tokio::test]
async fn start_tls_upgrades_after_the_plain_exchange() -> anyhow::Result<()> {
    let port = tls_server(true).await?;
    for backend in backends() {
        let policy = SocketPolicy::deny_all().allow("127.0.0.1", port)?;
        let mut app = app(backend, trusting()?, policy)?;
        assert_eq!(
            start_tls(&mut app, port).await?,
            json!({
                "greeting": "GO\n",
                "received": "tls:hello",
                "close": { "code": 1000, "reason": "" },
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_start_tls_handshake_closes_with_1011() -> anyhow::Result<()> {
    let port = tls_server(true).await?;
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            start_tls(&mut app, port).await?,
            json!({
                "greeting": "GO\n",
                "close": { "code": 1011, "reason": "TLS handshake failed" },
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn start_tls_needs_a_starttls_socket() -> anyhow::Result<()> {
    let port = server("echo:", false).await?;
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            app.call_json("startTlsRefused", &[json!("127.0.0.1"), json!(port)])
                .await?,
            json!("INVALID_REQUEST")
        );
    }
    Ok(())
}

#[tokio::test]
async fn ending_the_writes_half_closes_the_connection() -> anyhow::Result<()> {
    let port = collecting_server().await?;
    for backend in backends() {
        let (transport, policy) = loopback(port)?;
        let mut app = app(backend, transport, policy)?;
        assert_eq!(
            app.call_json(
                "halfClose",
                &[json!("127.0.0.1"), json!(port), json!("abc")]
            )
            .await?,
            json!({
                "received": "got:abc",
                "ended": true,
                "close": { "code": 1000, "reason": "" },
            })
        );
    }
    Ok(())
}

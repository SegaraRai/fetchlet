//! TcpTransport: JavaScript's sockets reach TCP servers, within the address
//! checks of the transport and the policy of its service.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use fetchlet::{App, Backend, HostServices, Limits, Module, SocketPolicy, SocketService};
use fetchlet_http::TcpTransport;

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

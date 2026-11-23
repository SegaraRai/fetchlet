//! WebSocket upgrades through `ActixService` over a real socket: the
//! handshake, frames both ways, both closing handshakes, the message
//! budget and the `max_held_connections` budget.

use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::time::Duration;

use actix_web::HttpServer;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use fetchlet::{App, AppHandle, Backend, Instances, Limits, Module, WorkerOptions};
use fetchlet_http::ActixService;

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A server WebSocket over the bridge's channel registry, as
/// `upgradeWebSocket` in @fetchlet/web builds one.
const SERVER: &str = r#"
const channels = globalThis.__fetchletChannels;
globalThis.fetchletExports = {
  handle(request) {
    let id;
    try {
      id = channels.upgrade({
        open() {},
        message(data) {
          if (data === "close") {
            channels.close(id, 4000, "bye");
          } else {
            channels.send(id, typeof data === "string" ? `echo:${data}` : data);
          }
        },
        close() {},
      });
    } catch (error) {
      return { status: 426, headers: [["x-error", String(error.code)]], body: [] };
    }
    return {
      status: 101,
      headers: [["sec-websocket-protocol", "chat"], ["x-handler", "accepted"]],
      body: [],
      upgrade: id,
    };
  },
};
"#;

fn backends() -> Vec<Backend> {
    vec![Backend::quickjs(), Backend::boa(), Backend::v8()]
}

async fn serve(backend: Backend, held: usize) -> anyhow::Result<(SocketAddr, AppHandle)> {
    serve_with(backend, held, Limits::default()).await
}

async fn serve_with(
    backend: Backend,
    held: usize,
    limits: Limits,
) -> anyhow::Result<(SocketAddr, AppHandle)> {
    let mut options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
    options.instances = Instances {
        max_held_connections: held,
        ..Instances::fixed(NonZeroUsize::new(2).unwrap())
    };
    let app = App::builder(backend)
        .module(Module::new(SERVER))
        .limits(limits)
        .spawn(options)
        .await?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let service = ActixService::new(app.clone(), "http://socket.test")?;
    let server =
        HttpServer::new(move || actix_web::App::new().default_service(service.clone().route()))
            .workers(1)
            .disable_signals()
            .listen(listener)?
            .run();
    actix_web::rt::spawn(server);
    Ok((address, app))
}

async fn connect(address: SocketAddr) -> Result<Client, WsError> {
    let mut request = format!("ws://{address}/socket").into_client_request()?;
    request
        .headers_mut()
        .insert("sec-websocket-protocol", "chat".parse().unwrap());
    let (client, response) = connect_async(request).await?;
    assert_eq!(response.headers()["sec-websocket-protocol"], "chat");
    assert_eq!(response.headers()["x-handler"], "accepted");
    Ok(client)
}

async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    match tokio::time::timeout(Duration::from_secs(10), future).await {
        Ok(output) => output,
        Err(_) => panic!("timed out waiting for {what}"),
    }
}

async fn next(client: &mut Client) -> Option<Message> {
    within("a message", client.next())
        .await
        .map(|message| message.unwrap())
}

async fn place_returns(app: &AppHandle) {
    within("the held place to return", async {
        while app.reserve_connection().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

#[actix_web::test]
async fn frames_cross_and_javascript_closes() -> anyhow::Result<()> {
    for backend in backends() {
        let (address, app) = serve(backend, 1).await?;
        let mut client = connect(address).await?;
        client.send(Message::text("hi")).await?;
        assert_eq!(next(&mut client).await, Some(Message::text("echo:hi")));
        client.send(Message::binary(vec![1, 2, 3])).await?;
        assert_eq!(
            next(&mut client).await,
            Some(Message::binary(vec![1, 2, 3]))
        );

        client.send(Message::text("close")).await?;
        assert_eq!(
            next(&mut client).await,
            Some(Message::Close(Some(CloseFrame {
                code: CloseCode::from(4000),
                reason: "bye".into(),
            })))
        );
        // The client answered; the server ends the connection.
        assert!(next(&mut client).await.is_none());
        place_returns(&app).await;
        app.shutdown().await?;
    }
    Ok(())
}

#[actix_web::test]
async fn the_client_closes() -> anyhow::Result<()> {
    for backend in backends() {
        let (address, app) = serve(backend, 1).await?;
        let mut client = connect(address).await?;
        client
            .close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "done".into(),
            }))
            .await?;
        assert_eq!(
            next(&mut client).await,
            Some(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "done".into(),
            })))
        );
        place_returns(&app).await;

        // A client that disappears ends the connection too.
        let client = connect(address).await?;
        drop(client);
        place_returns(&app).await;
        app.shutdown().await?;
    }
    Ok(())
}

#[actix_web::test]
async fn upgrades_past_the_budget_are_refused_before_javascript() -> anyhow::Result<()> {
    for backend in backends() {
        let (address, app) = serve(backend, 1).await?;
        let mut first = connect(address).await?;
        match connect(address).await {
            Err(WsError::Http(response)) => assert_eq!(response.status(), 503),
            other => panic!("expected 503, got {other:?}"),
        }
        first.send(Message::text("still")).await?;
        assert_eq!(next(&mut first).await, Some(Message::text("echo:still")));
        drop(first);
        app.shutdown().await?;

        // An application that holds no connections answers upgrade
        // requests itself.
        let (address, app) = serve(backend, 0).await?;
        match connect(address).await {
            Err(WsError::Http(response)) => {
                assert_eq!(response.status(), 426);
                assert_eq!(response.headers()["x-error"], "PERMISSION_DENIED");
            }
            other => panic!("expected 426, got {other:?}"),
        }
        app.shutdown().await?;
    }
    Ok(())
}

#[actix_web::test]
async fn shutdown_closes_open_sockets() -> anyhow::Result<()> {
    for backend in backends() {
        let (address, app) = serve(backend, 1).await?;
        let mut client = connect(address).await?;
        let stopping = app.clone();
        let shutdown = tokio::spawn(async move { stopping.shutdown().await });
        assert_eq!(
            next(&mut client).await,
            Some(Message::Close(Some(CloseFrame {
                code: CloseCode::Away,
                reason: "the server is shutting down".into(),
            })))
        );
        within("shutdown", shutdown).await??;
    }
    Ok(())
}

#[actix_web::test]
async fn messages_over_the_budget_close_with_1009() -> anyhow::Result<()> {
    for backend in backends() {
        let limits = Limits {
            channel_message_bytes: Some(16),
            ..Limits::default()
        };
        let (address, app) = serve_with(backend, 1, limits).await?;
        let mut client = connect(address).await?;
        client.send(Message::text("small")).await?;
        assert_eq!(next(&mut client).await, Some(Message::text("echo:small")));
        client.send(Message::text("x".repeat(64))).await?;
        assert_eq!(
            next(&mut client).await,
            Some(Message::Close(Some(CloseFrame {
                code: CloseCode::Size,
                reason: "message too big".into(),
            })))
        );
        place_returns(&app).await;
        app.shutdown().await?;
    }
    Ok(())
}

#[actix_web::test]
async fn fragments_and_pings() -> anyhow::Result<()> {
    use tokio_tungstenite::tungstenite::protocol::frame::{
        Frame,
        coding::{Data, OpCode},
    };
    for backend in backends() {
        let (address, app) = serve(backend, 1).await?;
        let mut client = connect(address).await?;
        client.send(Message::Ping(vec![7].into())).await?;
        assert_eq!(next(&mut client).await, Some(Message::Pong(vec![7].into())));
        let first = Frame::message(b"frag".to_vec(), OpCode::Data(Data::Text), false);
        let last = Frame::message(b"ments".to_vec(), OpCode::Data(Data::Continue), true);
        client.send(Message::Frame(first)).await?;
        client.send(Message::Frame(last)).await?;
        assert_eq!(
            next(&mut client).await,
            Some(Message::text("echo:fragments"))
        );
        drop(client);
        place_returns(&app).await;
        app.shutdown().await?;
    }
    Ok(())
}

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::rustls::ClientConfig;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use fetchlet::http::{HeaderValue, header};
use fetchlet::{
    ChannelEnd, Error, WebSocketAccept, WebSocketFuture, WebSocketRequest, WebSocketTransport,
};

use super::relay::relay;
use crate::network::{Connector, runtime};

/// A [`WebSocketTransport`] that opens client WebSockets over TCP, with TLS
/// for `wss:`.
///
/// Pair it with a `FetchPolicy` in a `WebSocketService`: the policy
/// authorizes the origins JavaScript connects to, and this transport
/// resolves their hosts and refuses any resolved address that is not
/// public, such as loopback, private and link-local networks, unless
/// [`allow_private_addresses`](Self::allow_private_addresses). A host that
/// resolves to no allowed address fails with `PermissionDenied`.
///
/// The opening handshake asks for the subprotocols JavaScript requested and
/// carries the service's credential headers; tungstenite performs it and
/// the framing, answers pings and validates the server's selection. No
/// extensions are requested. `Limits::channel_message_bytes` bounds each
/// message and frame from the server. Connecting and relaying run on the
/// Tokio runtime that polls the host pump; an App without one fails each
/// connection with `Configuration`. TLS verifies the server against the
/// Mozilla roots in `webpki-roots`, or the configuration from
/// [`with_tls_config`](Self::with_tls_config).
#[derive(Clone)]
pub struct WebSocketClient {
    connector: Connector,
}

impl WebSocketClient {
    /// Connect to public addresses, verifying `wss:` servers against the
    /// `webpki-roots` certificates.
    pub fn new() -> Self {
        Self {
            connector: Connector::new(),
        }
    }

    /// Connect to public addresses, using `config` for `wss:`, such as one
    /// that trusts a private certificate authority.
    pub fn with_tls_config(config: Arc<ClientConfig>) -> Self {
        Self {
            connector: Connector::with_tls_config(config),
        }
    }

    /// Also connect to loopback, private and other non-public addresses,
    /// for a host whose services run beside it.
    pub fn allow_private_addresses(mut self) -> Self {
        self.connector.allow_private_addresses();
        self
    }
}

impl Default for WebSocketClient {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for WebSocketClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebSocketClient")
            .field(
                "allow_private_addresses",
                &self.connector.allows_private_addresses(),
            )
            .finish_non_exhaustive()
    }
}

impl WebSocketTransport for WebSocketClient {
    fn connect(&self, request: WebSocketRequest) -> WebSocketFuture {
        let connector = self.connector.clone();
        Box::pin(async move {
            let runtime = runtime("WebSocketClient")?;
            let WebSocketRequest {
                url,
                protocols,
                headers,
                end,
                ..
            } = request;
            // The host without the brackets of an IPv6 literal.
            let host = url
                .host_str()
                .map(|host| {
                    host.trim_start_matches('[')
                        .trim_end_matches(']')
                        .to_owned()
                })
                .ok_or_else(|| Error::InvalidRequest("a WebSocket URL needs a host".into()))?;
            let port = url
                .port_or_known_default()
                .ok_or_else(|| Error::InvalidRequest("a WebSocket URL needs a port".into()))?;

            let mut handshake = url
                .as_str()
                .into_client_request()
                .map_err(|_| Error::InvalidRequest("invalid WebSocket URL".into()))?;
            handshake.headers_mut().extend(headers);
            if !protocols.is_empty() {
                let value = HeaderValue::from_str(&protocols.join(", "))
                    .map_err(|_| Error::InvalidRequest("invalid WebSocket subprotocol".into()))?;
                handshake
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, value);
            }

            let stream = connector.connect(&host, port).await?;
            if url.scheme() == "wss" {
                let stream = connector.secure(stream, &host).await?;
                open(runtime, handshake, stream, end).await
            } else {
                open(runtime, handshake, stream, end).await
            }
        })
    }
}

/// Perform the opening handshake over `stream`, then relay on a task.
async fn open<S>(
    runtime: tokio::runtime::Handle,
    handshake: fetchlet::http::Request<()>,
    stream: S,
    end: ChannelEnd,
) -> fetchlet::Result<WebSocketAccept>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let limit = end.max_message_bytes();
    let config = WebSocketConfig::default()
        .max_message_size(limit)
        .max_frame_size(limit);
    let (socket, response) =
        tokio_tungstenite::client_async_with_config(handshake, stream, Some(config))
            .await
            .map_err(|error| Error::Transport(format!("WebSocket handshake failed: {error}")))?;
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let accepted = WebSocketAccept {
        protocol: header(header::SEC_WEBSOCKET_PROTOCOL),
        extensions: header(header::SEC_WEBSOCKET_EXTENSIONS),
    };
    runtime.spawn(relay(socket, end));
    Ok(accepted)
}

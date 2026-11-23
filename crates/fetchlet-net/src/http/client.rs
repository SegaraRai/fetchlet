use std::error::Error as _;
use std::sync::Arc;
use std::time::Duration;

use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use tokio_rustls::rustls::ClientConfig;

use fetchlet::http::Version;
use fetchlet::{Body, Error, FetchTransport, Request, TransportFuture};

use super::connect::Connect;
use crate::network::{Connector, runtime};

/// How long an idle pooled connection stays open by default: hyper-util's
/// own default, long enough to reuse a connection between the requests of
/// one page and short enough not to hold servers' sockets for long.
const DEFAULT_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// A [`FetchTransport`] that sends JavaScript's outbound `fetch` requests
/// to HTTP servers, with TLS for `https:`.
///
/// Pair it with a `FetchPolicy` in a `FetchService`, or register it as the
/// outbound transport of `HostServices`: the policy authorizes the origins
/// JavaScript reaches, and this transport resolves their hosts and refuses
/// any resolved address that is not public, such as loopback, private and
/// link-local networks, unless
/// [`allow_private_addresses`](Self::allow_private_addresses). A host that
/// resolves to no allowed address fails with `PermissionDenied`.
///
/// Each call sends one request and returns its response as it arrives,
/// with the body streaming; redirects return to the caller, which follows
/// them under its policy, as the transport contract requires. hyper speaks
/// HTTP/1.1, and HTTP/2 when a TLS server selects it by ALPN; connections
/// to one origin are pooled and reused, and an idle one closes after
/// [`pool_idle_timeout`](Self::pool_idle_timeout). The transport adds no
/// `Accept-Encoding` and decodes no `Content-Encoding`, so the body reaches
/// JavaScript as the server sent it. Requests run on the Tokio runtime that
/// polls the host pump; an App without one fails each request with
/// `Configuration`. TLS verifies the server against the Mozilla roots in
/// `webpki-roots`, or the configuration from
/// [`with_tls_config`](Self::with_tls_config). Dropping the request's future
/// or its response body closes that exchange.
#[derive(Clone)]
pub struct HttpClient {
    connector: Connector,
    pool_idle_timeout: Option<Duration>,
    client: Client<Connect, Body>,
}

impl HttpClient {
    /// Connect to public addresses, verifying `https:` servers against the
    /// `webpki-roots` certificates.
    pub fn new() -> Self {
        Self::build(Connector::new(), Some(DEFAULT_POOL_IDLE_TIMEOUT))
    }

    /// Connect to public addresses, using `config` for `https:`, such as one
    /// that trusts a private certificate authority. Unless `config` names
    /// its own ALPN protocols, the client offers HTTP/2 and HTTP/1.1.
    pub fn with_tls_config(config: Arc<ClientConfig>) -> Self {
        Self::build(
            Connector::with_tls_config(config),
            Some(DEFAULT_POOL_IDLE_TIMEOUT),
        )
    }

    /// Also connect to loopback, private and other non-public addresses,
    /// for a host whose services run beside it.
    pub fn allow_private_addresses(mut self) -> Self {
        self.connector.allow_private_addresses();
        Self::build(self.connector, self.pool_idle_timeout)
    }

    /// Close a pooled connection after it has been idle for `timeout`, or
    /// never with `None`. The default is 90 seconds.
    pub fn pool_idle_timeout(self, timeout: Option<Duration>) -> Self {
        Self::build(self.connector, timeout)
    }

    fn build(connector: Connector, pool_idle_timeout: Option<Duration>) -> Self {
        let connector = connector.with_alpn(&[b"h2", b"http/1.1"]);
        let client = Client::builder(TokioExecutor::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(pool_idle_timeout)
            .build(Connect {
                connector: connector.clone(),
            });
        Self {
            connector,
            pool_idle_timeout,
            client,
        }
    }
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for HttpClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpClient")
            .field(
                "allow_private_addresses",
                &self.connector.allows_private_addresses(),
            )
            .field("pool_idle_timeout", &self.pool_idle_timeout)
            .finish_non_exhaustive()
    }
}

impl FetchTransport for HttpClient {
    fn send(&self, mut request: Request) -> TransportFuture {
        let client = self.client.clone();
        Box::pin(async move {
            // hyper spawns its connections on the current runtime.
            runtime("HttpClient")?;
            match request.uri().scheme_str() {
                Some("http" | "https") => {}
                _ => return Err(Error::InvalidRequest("unsupported URL scheme".into())),
            }
            // hyper chooses HTTP/2 by the connection, not the request.
            *request.version_mut() = Version::HTTP_11;
            let response = client.request(request).await.map_err(failed)?;
            Ok(response.map(Body::from_http_body))
        })
    }
}

/// The error of a failed exchange: the connector's own error, such as a
/// refused address, or a transport error with hyper's description.
fn failed(error: hyper_util::client::legacy::Error) -> Error {
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(cause) = cause.downcast_ref::<Error>() {
            return match cause {
                Error::PermissionDenied => Error::PermissionDenied,
                Error::InvalidRequest(message) => Error::InvalidRequest(message.clone()),
                Error::LimitExceeded(resource) => Error::LimitExceeded(resource),
                Error::Transport(message) => Error::Transport(message.clone()),
                other => Error::Transport(other.to_string()),
            };
        }
        source = cause.source();
    }
    Error::Transport(format!("HTTP request failed: {error}"))
}

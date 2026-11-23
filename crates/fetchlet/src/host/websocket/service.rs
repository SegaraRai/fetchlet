use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use http::HeaderMap;
use url::Url;

use crate::{ChannelEnd, Context, Error, FetchPolicy, Result};

/// A client WebSocket JavaScript opened with `new WebSocket(url, protocols)`.
#[non_exhaustive]
pub struct WebSocketRequest {
    /// The `ws:` or `wss:` URL, after the service's rewrite and policy check.
    pub url: Url,
    /// The subprotocols JavaScript asked for, in order, for
    /// `Sec-WebSocket-Protocol`.
    pub protocols: Vec<String>,
    /// Headers for the opening handshake from the service's credentials
    /// hook; empty without one.
    pub headers: HeaderMap,
    /// The invocation's trusted [`Context`], for a service configured with
    /// [`WebSocketService::forward_context`].
    pub context: Option<Context>,
    /// Rust's end of the socket's channel. The transport carries its text
    /// and binary messages to the server and the server's messages back,
    /// answers JavaScript's close with the closing handshake, and reports
    /// the server's close with [`ChannelEnd::close`]. A connection that ends
    /// without a closing handshake drops the end, which JavaScript sees as
    /// 1006.
    pub end: ChannelEnd,
}

/// What the server selected in the opening handshake.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebSocketAccept {
    /// The subprotocol, one of those requested, or empty.
    pub protocol: String,
    /// The `Sec-WebSocket-Extensions` the server accepted, or empty.
    pub extensions: String,
}

/// The opening handshake of a client WebSocket.
pub type WebSocketFuture = Pin<Box<dyn Future<Output = Result<WebSocketAccept>> + Send + 'static>>;

/// A trusted transport that opens client WebSockets for JavaScript.
///
/// `connect` returns a future that settles the opening handshake: the
/// server's selection once it succeeds, an error when it fails or is
/// refused, which JavaScript sees as a connection that closed with 1006.
/// The transport then relays messages between the connection and
/// `request.end` until either side closes, usually on a task it spawns. The
/// future is polled in the host pump, within the host runtime when the App
/// has one, and dropping it, as the end of the invocation does, must
/// abandon the connection. A transport that reaches a network must check
/// the addresses it resolves: the policy authorizes origins, not where
/// their names lead.
pub trait WebSocketTransport: Send + Sync + 'static {
    fn connect(&self, request: WebSocketRequest) -> WebSocketFuture;
}

/// Share one transport between services or Apps.
impl<T: WebSocketTransport + ?Sized> WebSocketTransport for Arc<T> {
    fn connect(&self, request: WebSocketRequest) -> WebSocketFuture {
        (**self).connect(request)
    }
}

struct FunctionTransport<F>(F);

impl<F, Fut> WebSocketTransport for FunctionTransport<F>
where
    F: Fn(WebSocketRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<WebSocketAccept>> + Send + 'static,
{
    fn connect(&self, request: WebSocketRequest) -> WebSocketFuture {
        Box::pin((self.0)(request))
    }
}

/// Adapt an async Rust function, such as an in-process server or a mock, to
/// a WebSocket transport.
pub fn websocket_fn<F, Fut>(function: F) -> impl WebSocketTransport
where
    F: Fn(WebSocketRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<WebSocketAccept>> + Send + 'static,
{
    FunctionTransport(function)
}

type UrlRewrite = Arc<dyn Fn(&mut Url) -> Result<()> + Send + Sync>;
type CredentialProvider = Arc<dyn Fn(&Url, &mut HeaderMap) -> Result<()> + Send + Sync>;

/// A WebSocket transport with the [`FetchPolicy`] that authorizes the
/// origin of each URL JavaScript connects to, `ws:` and `wss:` counting as
/// `http:` and `https:`, as [`FetchService`](crate::FetchService) pairs a
/// fetch transport with it.
#[derive(Clone)]
pub struct WebSocketService {
    transport: Arc<dyn WebSocketTransport>,
    policy: FetchPolicy,
    rewrite: Option<UrlRewrite>,
    credentials: Option<CredentialProvider>,
    forward_context: bool,
}

impl WebSocketService {
    pub fn new(transport: impl WebSocketTransport, policy: FetchPolicy) -> Self {
        Self {
            transport: Arc::new(transport),
            policy,
            rewrite: None,
            credentials: None,
            forward_context: false,
        }
    }

    /// Change the URL before the policy check. The result must stay a
    /// `ws:` or `wss:` URL.
    pub fn rewrite(
        mut self,
        rewrite: impl Fn(&mut Url) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.rewrite = Some(Arc::new(rewrite));
        self
    }

    /// Add headers to the opening handshake after the policy check, such as
    /// an authorization JavaScript must not see. The provider must scope
    /// them to the URL it is given.
    pub fn credentials(
        mut self,
        credentials: impl Fn(&Url, &mut HeaderMap) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.credentials = Some(Arc::new(credentials));
        self
    }

    /// Pass the invocation's [`Context`] to the transport, for trusted
    /// in-process transports. Without it, the transport never receives one.
    pub fn forward_context(mut self) -> Self {
        self.forward_context = true;
        self
    }

    /// Check, rewrite and authorize the URL and subprotocols, add the
    /// credentials, then start the transport's handshake. Fails with
    /// `PermissionDenied` for an origin the policy does not allow and with
    /// `InvalidRequest` for an invalid URL or subprotocol.
    pub(crate) fn open(
        &self,
        url: &str,
        protocols: Vec<String>,
        context: Option<Context>,
        end: ChannelEnd,
    ) -> Result<WebSocketFuture> {
        let mut url = websocket_url(url)?;
        validate_protocols(&protocols)?;
        if let Some(rewrite) = &self.rewrite {
            rewrite(&mut url)?;
            url = websocket_url(url.as_str())?;
        }
        self.policy.check_websocket(&url)?;
        let mut headers = HeaderMap::new();
        if let Some(credentials) = &self.credentials {
            credentials(&url, &mut headers)?;
        }
        Ok(self.transport.connect(WebSocketRequest {
            url,
            protocols,
            headers,
            context: context.filter(|_| self.forward_context),
            end,
        }))
    }
}

/// A `ws:` or `wss:` URL with a host, without credentials or a fragment.
fn websocket_url(input: &str) -> Result<Url> {
    let url = Url::parse(input).map_err(|_| invalid("invalid WebSocket URL"))?;
    if !matches!(url.scheme(), "ws" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "expected a ws: or wss: URL without credentials or fragment",
        ));
    }
    Ok(url)
}

/// Subprotocols are distinct tokens (RFC 6455 §4.1, RFC 9110 §5.6.2).
fn validate_protocols(protocols: &[String]) -> Result<()> {
    let token = |protocol: &str| {
        !protocol.is_empty()
            && protocol
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    };
    for (index, protocol) in protocols.iter().enumerate() {
        if !token(protocol) || protocols[..index].contains(protocol) {
            return Err(invalid("invalid WebSocket subprotocol"));
        }
    }
    Ok(())
}

fn invalid(message: &str) -> Error {
    Error::InvalidRequest(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_protocols_are_checked() {
        assert!(websocket_url("wss://example.test/chat?room=1").is_ok());
        for url in [
            "https://example.test/",
            "ws://user@example.test/",
            "ws://example.test/#top",
            "wss://",
            "not a url",
        ] {
            assert!(websocket_url(url).is_err(), "{url}");
        }
        assert!(validate_protocols(&["chat".into(), "v2.json".into()]).is_ok());
        for protocols in [
            vec!["".to_owned()],
            vec!["a b".into()],
            vec!["x".into(), "x".into()],
        ] {
            assert!(validate_protocols(&protocols).is_err(), "{protocols:?}");
        }
    }

    #[test]
    fn the_policy_treats_ws_as_http() -> Result<()> {
        let policy = FetchPolicy::deny_all()
            .allow_origin("https://example.test")?
            .allow_origin("http://plain.test:8080")?;
        let check = |url: &str| policy.check_websocket(&Url::parse(url).unwrap());
        assert!(check("wss://example.test/socket").is_ok());
        assert!(check("ws://plain.test:8080/").is_ok());
        assert!(matches!(
            check("ws://example.test/"),
            Err(Error::PermissionDenied)
        ));
        assert!(matches!(
            check("wss://plain.test:8080/"),
            Err(Error::PermissionDenied)
        ));
        assert!(matches!(
            check("wss://other.test/"),
            Err(Error::PermissionDenied)
        ));
        Ok(())
    }
}

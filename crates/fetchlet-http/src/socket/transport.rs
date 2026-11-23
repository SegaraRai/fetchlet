use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use fetchlet::{ChannelFuture, Error, SecureTransport, SocketRequest, SocketTransport};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{self, ClientConfig, RootCertStore};

use super::address::is_public;
use super::relay::{StartTls, relay, relay_secure};

/// A [`SocketTransport`] that opens TCP connections, with TLS from the
/// start for `secureTransport: "on"` and after `startTls()` for
/// `"starttls"`.
///
/// Pair it with a `SocketPolicy` in a `SocketService`: the policy
/// authorizes the names JavaScript connects to, and this transport resolves
/// them and refuses any resolved address that is not public, such as
/// loopback, private and link-local networks, unless
/// [`allow_private_addresses`](Self::allow_private_addresses). A name that
/// resolves to no allowed address fails with `PermissionDenied`.
///
/// Connecting and relaying run on the Tokio runtime that polls the host
/// pump; an App without one fails each connect with `Configuration`. TLS
/// verifies the server against the Mozilla roots in `webpki-roots`, or the
/// configuration from [`with_tls_config`](Self::with_tls_config).
#[derive(Clone)]
pub struct TcpTransport {
    tls: Arc<ClientConfig>,
    allow_private_addresses: bool,
}

impl TcpTransport {
    /// Connect to public addresses, verifying TLS servers against the
    /// `webpki-roots` certificates.
    pub fn new() -> Self {
        let roots = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("the ring provider supports the default protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
        Self::with_tls_config(Arc::new(config))
    }

    /// Connect to public addresses, using `config` for TLS, such as one
    /// that trusts a private certificate authority.
    pub fn with_tls_config(config: Arc<ClientConfig>) -> Self {
        Self {
            tls: config,
            allow_private_addresses: false,
        }
    }

    /// Also connect to loopback, private and other non-public addresses,
    /// for a host whose services run beside it, such as a database on the
    /// same network.
    pub fn allow_private_addresses(mut self) -> Self {
        self.allow_private_addresses = true;
        self
    }

    async fn resolve(&self, host: &str, port: u16) -> fetchlet::Result<Vec<SocketAddr>> {
        let resolved = tokio::net::lookup_host((host, port))
            .await
            .map_err(|error| Error::Transport(format!("cannot resolve {host}: {error}")))?;
        let allowed: Vec<SocketAddr> = resolved
            .filter(|address| self.allow_private_addresses || is_public(address.ip()))
            .collect();
        if allowed.is_empty() {
            return Err(Error::PermissionDenied);
        }
        Ok(allowed)
    }
}

impl Default for TcpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for TcpTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TcpTransport")
            .field("allow_private_addresses", &self.allow_private_addresses)
            .finish_non_exhaustive()
    }
}

impl SocketTransport for TcpTransport {
    fn connect(&self, request: SocketRequest) -> ChannelFuture {
        let transport = self.clone();
        Box::pin(async move {
            let runtime = tokio::runtime::Handle::try_current()
                .map_err(|_| Error::Configuration("TcpTransport needs a Tokio runtime".into()))?;
            let SocketRequest {
                address,
                secure_transport,
                end,
                ..
            } = request;
            let host = address.host();
            let addresses = transport.resolve(host, address.port()).await?;
            let stream = connect_any(&addresses).await.map_err(|error| {
                Error::Transport(format!("cannot connect to {address}: {error}"))
            })?;
            let name = || {
                ServerName::try_from(host.to_owned())
                    .map_err(|_| Error::InvalidRequest(format!("invalid TLS server name {host}")))
            };
            let connector = TlsConnector::from(transport.tls);
            match secure_transport {
                SecureTransport::Off => {
                    runtime.spawn(relay(stream, end, None));
                }
                SecureTransport::On => {
                    let stream = connector.connect(name()?, stream).await.map_err(|error| {
                        Error::Transport(format!("TLS with {address} failed: {error}"))
                    })?;
                    runtime.spawn(relay_secure(stream, end));
                }
                SecureTransport::StartTls => {
                    let upgrade = StartTls {
                        connector,
                        name: name()?,
                    };
                    runtime.spawn(relay(stream, end, Some(upgrade)));
                }
            }
            Ok(())
        })
    }
}

/// Connect to the first address that accepts, in resolution order.
async fn connect_any(addresses: &[SocketAddr]) -> io::Result<TcpStream> {
    let mut last = None;
    for address in addresses {
        match TcpStream::connect(address).await {
            Ok(stream) => {
                // Writes carry what JavaScript wrote; it batches as it needs.
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::from(io::ErrorKind::AddrNotAvailable)))
}

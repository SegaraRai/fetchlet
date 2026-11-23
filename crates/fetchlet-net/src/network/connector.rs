use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{self, ClientConfig, RootCertStore};

use fetchlet::Error;

use super::address::is_public;

/// How the network transports reach a host: name resolution that refuses
/// non-public addresses unless allowed, TCP, and TLS with a rustls
/// configuration.
#[derive(Clone)]
pub(crate) struct Connector {
    tls: Arc<ClientConfig>,
    allow_private_addresses: bool,
}

impl Connector {
    /// Verify TLS servers against the `webpki-roots` certificates.
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

    pub fn with_tls_config(config: Arc<ClientConfig>) -> Self {
        Self {
            tls: config,
            allow_private_addresses: false,
        }
    }

    /// Offer `protocols` by ALPN in TLS handshakes, unless the configuration
    /// already names its own.
    #[cfg(feature = "http")]
    pub fn with_alpn(mut self, protocols: &[&[u8]]) -> Self {
        if self.tls.alpn_protocols.is_empty() {
            let mut config = (*self.tls).clone();
            config.alpn_protocols = protocols.iter().map(|protocol| protocol.to_vec()).collect();
            self.tls = Arc::new(config);
        }
        self
    }

    pub fn allow_private_addresses(&mut self) {
        self.allow_private_addresses = true;
    }

    pub fn allows_private_addresses(&self) -> bool {
        self.allow_private_addresses
    }

    /// Resolve `host` and connect to the first allowed address that
    /// accepts. A name with no allowed address fails with
    /// `PermissionDenied`.
    pub async fn connect(&self, host: &str, port: u16) -> fetchlet::Result<TcpStream> {
        let addresses = self.resolve(host, port).await?;
        connect_any(&addresses)
            .await
            .map_err(|error| Error::Transport(format!("cannot connect to {host}:{port}: {error}")))
    }

    /// Perform the TLS handshake with `stream` for `host`.
    pub async fn secure(
        &self,
        stream: TcpStream,
        host: &str,
    ) -> fetchlet::Result<TlsStream<TcpStream>> {
        self.tls_connector()
            .connect(server_name(host)?, stream)
            .await
            .map_err(|error| Error::Transport(format!("TLS with {host} failed: {error}")))
    }

    pub fn tls_connector(&self) -> TlsConnector {
        TlsConnector::from(self.tls.clone())
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

/// The TLS name of a host name or IP literal, without brackets.
pub(crate) fn server_name(host: &str) -> fetchlet::Result<ServerName<'static>> {
    ServerName::try_from(host.to_owned())
        .map_err(|_| Error::InvalidRequest(format!("invalid TLS server name {host}")))
}

/// The Tokio runtime that polls the host pump, which connections run on.
pub(crate) fn runtime(transport: &str) -> fetchlet::Result<tokio::runtime::Handle> {
    tokio::runtime::Handle::try_current()
        .map_err(|_| Error::Configuration(format!("{transport} needs a Tokio runtime")))
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

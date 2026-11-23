use std::sync::Arc;

use tokio_rustls::rustls::ClientConfig;

use fetchlet::{ChannelFuture, SecureTransport, SocketRequest, SocketTransport};

use super::relay::{StartTls, relay, relay_secure};
use crate::network::{Connector, runtime, server_name};

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
    connector: Connector,
}

impl TcpTransport {
    /// Connect to public addresses, verifying TLS servers against the
    /// `webpki-roots` certificates.
    pub fn new() -> Self {
        Self {
            connector: Connector::new(),
        }
    }

    /// Connect to public addresses, using `config` for TLS, such as one
    /// that trusts a private certificate authority.
    pub fn with_tls_config(config: Arc<ClientConfig>) -> Self {
        Self {
            connector: Connector::with_tls_config(config),
        }
    }

    /// Also connect to loopback, private and other non-public addresses,
    /// for a host whose services run beside it, such as a database on the
    /// same network.
    pub fn allow_private_addresses(mut self) -> Self {
        self.connector.allow_private_addresses();
        self
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
            .field(
                "allow_private_addresses",
                &self.connector.allows_private_addresses(),
            )
            .finish_non_exhaustive()
    }
}

impl SocketTransport for TcpTransport {
    fn connect(&self, request: SocketRequest) -> ChannelFuture {
        let connector = self.connector.clone();
        Box::pin(async move {
            let runtime = runtime("TcpTransport")?;
            let SocketRequest {
                address,
                secure_transport,
                end,
                ..
            } = request;
            let host = address.host();
            let stream = connector.connect(host, address.port()).await?;
            match secure_transport {
                SecureTransport::Off => {
                    runtime.spawn(relay(stream, end, None));
                }
                SecureTransport::On => {
                    let stream = connector.secure(stream, host).await?;
                    runtime.spawn(relay_secure(stream, end));
                }
                SecureTransport::StartTls => {
                    let upgrade = StartTls {
                        connector: connector.tls_connector(),
                        name: server_name(host)?,
                    };
                    runtime.spawn(relay(stream, end, Some(upgrade)));
                }
            }
            Ok(())
        })
    }
}

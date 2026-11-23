use std::future::Future;
use std::sync::Arc;

use super::SocketAddress;
use super::SocketPolicy;
use crate::{ChannelEnd, ChannelFuture, Context, Result};

/// Whether a socket speaks TLS from its start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureTransport {
    /// Plain TCP.
    Off,
    /// TLS from the start, verifying the server for the address's host.
    On,
}

/// A TCP connection JavaScript asked for with `connect(address, options)`.
#[non_exhaustive]
pub struct SocketRequest {
    /// The destination, after the service's rewrite and policy check.
    pub address: SocketAddress,
    pub secure_transport: SecureTransport,
    /// The invocation's trusted [`Context`], for a service configured with
    /// [`SocketService::forward_context`].
    pub context: Option<Context>,
    /// Rust's end of the socket's channel. The transport carries the bytes
    /// of its binary messages to the connection and the connection's bytes
    /// back as binary messages, and closes it when the connection ends.
    pub end: ChannelEnd,
}

/// A trusted transport that opens TCP connections for JavaScript.
///
/// `connect` returns a future that settles the open: Ok once the connection
/// is established, an error when it fails or is refused. The transport then
/// relays bytes between the connection and `request.end` until either side
/// closes, usually on a task it spawns. The future is polled in the host
/// pump, within the host runtime when the App has one, and dropping it, as
/// the end of the invocation does, must abandon the connection. A transport
/// that reaches a network must check the addresses it resolves:
/// [`SocketPolicy`] authorizes names, not where they lead.
pub trait SocketTransport: Send + Sync + 'static {
    fn connect(&self, request: SocketRequest) -> ChannelFuture;
}

/// Share one transport between services or Apps.
impl<T: SocketTransport + ?Sized> SocketTransport for Arc<T> {
    fn connect(&self, request: SocketRequest) -> ChannelFuture {
        (**self).connect(request)
    }
}

struct FunctionTransport<F>(F);

impl<F, Fut> SocketTransport for FunctionTransport<F>
where
    F: Fn(SocketRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    fn connect(&self, request: SocketRequest) -> ChannelFuture {
        Box::pin((self.0)(request))
    }
}

/// Adapt an async Rust function, such as an in-process server or a mock, to
/// a socket transport.
pub fn socket_fn<F, Fut>(function: F) -> impl SocketTransport
where
    F: Fn(SocketRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    FunctionTransport(function)
}

type AddressRewrite = Arc<dyn Fn(&mut SocketAddress) -> Result<()> + Send + Sync>;

/// A socket transport with the policy that authorizes each address
/// JavaScript connects to, as [`FetchService`](crate::FetchService) pairs a
/// fetch transport with a `FetchPolicy`.
#[derive(Clone)]
pub struct SocketService {
    transport: Arc<dyn SocketTransport>,
    policy: SocketPolicy,
    rewrite: Option<AddressRewrite>,
    forward_context: bool,
}

impl SocketService {
    pub fn new(transport: impl SocketTransport, policy: SocketPolicy) -> Self {
        Self {
            transport: Arc::new(transport),
            policy,
            rewrite: None,
            forward_context: false,
        }
    }

    /// Change the address before the policy check, such as to send a
    /// database name JavaScript knows to the host that serves it.
    pub fn rewrite(
        mut self,
        rewrite: impl Fn(&mut SocketAddress) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.rewrite = Some(Arc::new(rewrite));
        self
    }

    /// Pass the invocation's [`Context`] to the transport, for trusted
    /// in-process transports. Without it, the transport never receives one.
    pub fn forward_context(mut self) -> Self {
        self.forward_context = true;
        self
    }

    /// Rewrite and authorize the address, then start the transport's
    /// connect. Fails with `PermissionDenied` for an address the policy does
    /// not allow.
    pub(crate) fn open(
        &self,
        mut address: SocketAddress,
        secure_transport: SecureTransport,
        context: Option<Context>,
        end: ChannelEnd,
    ) -> Result<ChannelFuture> {
        if let Some(rewrite) = &self.rewrite {
            rewrite(&mut address)?;
        }
        self.policy.check(&address)?;
        Ok(self.transport.connect(SocketRequest {
            address,
            secure_transport,
            context: context.filter(|_| self.forward_context),
            end,
        }))
    }
}

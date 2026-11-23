use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tower_service::Service;

use fetchlet::Error;
use fetchlet::http::Uri;

use crate::network::Connector;

/// The connector of the pooled hyper client: each new connection resolves
/// its host within the address checks of [`Connector`] and speaks TLS for
/// `https:`, reporting HTTP/2 when the server selects it by ALPN.
#[derive(Clone)]
pub(super) struct Connect {
    pub connector: Connector,
}

impl Service<Uri> for Connect {
    type Response = TokioIo<Stream>;
    type Error = Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let connector = self.connector.clone();
        Box::pin(async move {
            let secure = match uri.scheme_str() {
                Some("https") => true,
                Some("http") => false,
                _ => return Err(Error::InvalidRequest("unsupported URL scheme".into())),
            };
            // The host without the brackets of an IPv6 literal.
            let host = uri
                .host()
                .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
                .ok_or_else(|| Error::InvalidRequest("a request URL needs a host".into()))?;
            let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
            let stream = connector.connect(host, port).await?;
            let stream = if secure {
                Stream::Tls(Box::new(connector.secure(stream, host).await?))
            } else {
                Stream::Plain(stream)
            };
            Ok(TokioIo::new(stream))
        })
    }
}

/// A connection to an HTTP server, with TLS for `https:`.
pub(super) enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl Connection for Stream {
    fn connected(&self) -> Connected {
        match self {
            Self::Plain(_) => Connected::new(),
            Self::Tls(stream) if stream.get_ref().1.alpn_protocol() == Some(b"h2") => {
                Connected::new().negotiated_h2()
            }
            Self::Tls(_) => Connected::new(),
        }
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(context, buffer),
            Self::Tls(stream) => Pin::new(stream).poll_read(context, buffer),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(context, data),
            Self::Tls(stream) => Pin::new(stream).poll_write(context, data),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write_vectored(context, buffers),
            Self::Tls(stream) => Pin::new(stream).poll_write_vectored(context, buffers),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Plain(stream) => stream.is_write_vectored(),
            Self::Tls(stream) => stream.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(context),
            Self::Tls(stream) => Pin::new(stream).poll_flush(context),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(context),
            Self::Tls(stream) => Pin::new(stream).poll_shutdown(context),
        }
    }
}

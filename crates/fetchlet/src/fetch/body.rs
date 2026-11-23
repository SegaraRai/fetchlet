use std::fmt;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Bytes, BytesMut};
use http_body::{Frame, SizeHint};
use tokio::sync::mpsc;

use crate::config::check_limit;
use crate::{Error, Result};

/// One message from a body producer: a data chunk and whether it is the last one.
///
/// A producer that stops without sending a last chunk aborted the body; the
/// consumer then observes [`Error::InvocationClosed`].
pub(crate) type BodyChunk = Result<(Bytes, bool)>;

#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
pub(crate) type BodySender = mpsc::Sender<BodyChunk>;

/// An HTTP body owned by fetchlet.
///
/// A body is buffered, streamed from the worker that owns a JavaScript
/// invocation, or streamed from another `http_body::Body`. Streaming bodies
/// from a worker hold that invocation's lease until they finish or are
/// dropped; dropping one cancels the JavaScript stream.
#[derive(Debug, Default)]
pub struct Body {
    inner: Inner,
}

#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
#[derive(Debug)]
enum Inner {
    Buffered(Option<Bytes>),
    Streaming {
        prefix: Option<Bytes>,
        receiver: mpsc::Receiver<BodyChunk>,
        finished: bool,
    },
    External(ExternalBody),
}

/// A caller-supplied body, read on demand by the invocation that receives it.
pub(crate) struct ExternalBody(Pin<Box<dyn http_body::Body<Data = Bytes, Error = Error> + Send>>);

impl fmt::Debug for ExternalBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ExternalBody")
    }
}

/// A streaming body that fails once it has produced more than `limit` bytes.
struct Limited {
    body: Body,
    read: usize,
    limit: usize,
    resource: &'static str,
}

impl http_body::Body for Limited {
    type Data = Bytes;

    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>>>> {
        let this = self.get_mut();
        let frame = match Pin::new(&mut this.body).poll_frame(context) {
            Poll::Ready(Some(Ok(frame))) => frame,
            other => return other,
        };
        if let Some(chunk) = frame.data_ref() {
            this.read = this.read.saturating_add(chunk.len());
            if this.read > this.limit {
                return Poll::Ready(Some(Err(Error::LimitExceeded(this.resource))));
            }
        }
        Poll::Ready(Some(Ok(frame)))
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// Adapts the data and error types of a caller-supplied body.
struct MapBody<B>(B);

impl<B> http_body::Body for MapBody<B>
where
    B: http_body::Body + Unpin,
    B::Data: Into<Bytes>,
    B::Error: fmt::Display,
{
    type Data = Bytes;

    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>>>> {
        let inner = Pin::new(&mut self.get_mut().0);
        inner.poll_frame(context).map(|frame| {
            frame.map(|frame| {
                frame
                    .map(|frame| frame.map_data(Into::into))
                    .map_err(|error| Error::Transport(error.to_string()))
            })
        })
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.0.size_hint()
    }
}

impl Default for Inner {
    fn default() -> Self {
        Self::Buffered(None)
    }
}

impl Body {
    pub fn empty() -> Self {
        Self::default()
    }

    /// A streaming body whose chunks arrive through a bounded channel.
    #[cfg_attr(
        not(any(
            feature = "quickjs",
            feature = "boa",
            feature = "v8",
            feature = "fuzzing",
            test
        )),
        allow(dead_code)
    )]
    pub(crate) fn channel(prefix: Bytes, capacity: usize) -> (BodySender, Self) {
        let (sender, receiver) = mpsc::channel(capacity);
        let body = Self {
            inner: Inner::Streaming {
                prefix: (!prefix.is_empty()).then_some(prefix),
                receiver,
                finished: false,
            },
        };
        (sender, body)
    }

    /// Stream another HTTP body, such as an incoming server request body.
    ///
    /// The receiving invocation reads it on demand and applies its body budget
    /// to the bytes it reads. Trailers are not forwarded. Errors from `body`
    /// reach JavaScript as a general transport error; their detail stays in Rust.
    pub fn from_http_body<B>(body: B) -> Self
    where
        B: http_body::Body + Send + 'static,
        B::Data: Into<Bytes>,
        B::Error: fmt::Display,
    {
        if body.is_end_stream() {
            return Self::empty();
        }
        Self {
            inner: Inner::External(ExternalBody(Box::pin(MapBody(Box::pin(body))))),
        }
    }

    /// Stream a body of fetchlet's own, whose errors, such as
    /// `LimitExceeded`, reach the caller as they are.
    #[cfg_attr(
        not(any(
            feature = "boa",
            feature = "quickjs",
            feature = "v8",
            feature = "fuzzing",
            test
        )),
        allow(dead_code)
    )]
    pub(crate) fn from_fetchlet_body(
        body: impl http_body::Body<Data = Bytes, Error = Error> + Send + 'static,
    ) -> Self {
        Self {
            inner: Inner::External(ExternalBody(Box::pin(body))),
        }
    }

    /// The length the body declares at least: exact when buffered, otherwise
    /// its size hint, such as a `Content-Length`.
    pub(crate) fn declared_len(&self) -> usize {
        usize::try_from(http_body::Body::size_hint(self).lower()).unwrap_or(usize::MAX)
    }

    /// Whether every byte of the body is already in memory.
    #[cfg_attr(
        not(any(
            feature = "quickjs",
            feature = "boa",
            feature = "v8",
            feature = "fuzzing",
            test
        )),
        allow(dead_code)
    )]
    pub(crate) fn is_buffered(&self) -> bool {
        matches!(self.inner, Inner::Buffered(_))
    }

    /// Collect the body, rejecting a result larger than `limit` bytes.
    pub async fn collect(self, limit: usize) -> Result<Bytes> {
        self.collect_within(Some(limit), "body bytes").await
    }

    pub(crate) async fn collect_within(
        self,
        limit: Option<usize>,
        resource: &'static str,
    ) -> Result<Bytes> {
        match self.inner {
            Inner::Buffered(data) => {
                let data = data.unwrap_or_default();
                check_limit(limit, data.len(), resource)?;
                Ok(data)
            }
            Inner::Streaming {
                prefix,
                mut receiver,
                finished,
            } => {
                let mut data = BytesMut::new();
                if let Some(prefix) = prefix {
                    check_limit(limit, prefix.len(), resource)?;
                    data.extend_from_slice(&prefix);
                }
                if finished {
                    return Ok(data.freeze());
                }
                loop {
                    let (chunk, last) = receiver.recv().await.ok_or(Error::InvocationClosed)??;
                    let size = data
                        .len()
                        .checked_add(chunk.len())
                        .ok_or(Error::LimitExceeded(resource))?;
                    check_limit(limit, size, resource)?;
                    data.extend_from_slice(&chunk);
                    if last {
                        return Ok(data.freeze());
                    }
                }
            }
            Inner::External(ExternalBody(mut body)) => {
                let mut data = BytesMut::new();
                while let Some(frame) =
                    std::future::poll_fn(|context| body.as_mut().poll_frame(context)).await
                {
                    let Ok(chunk) = frame?.into_data() else {
                        continue;
                    };
                    let size = data
                        .len()
                        .checked_add(chunk.len())
                        .ok_or(Error::LimitExceeded(resource))?;
                    check_limit(limit, size, resource)?;
                    data.extend_from_slice(&chunk);
                }
                Ok(data.freeze())
            }
        }
    }

    /// Fail a streaming body with `LimitExceeded(resource)` once more than
    /// `limit` bytes have been read from it. A buffered body is returned as
    /// it is; check its length directly.
    pub(crate) fn limited(self, limit: Option<usize>, resource: &'static str) -> Self {
        match (limit, &self.inner) {
            (None, _) | (_, Inner::Buffered(_)) => self,
            (Some(limit), _) => Self {
                inner: Inner::External(ExternalBody(Box::pin(Limited {
                    body: self,
                    read: 0,
                    limit,
                    resource,
                }))),
            },
        }
    }

    /// Buffer a streaming body so that synchronous host checks can inspect it.
    pub(crate) async fn into_buffered(
        self,
        limit: Option<usize>,
        resource: &'static str,
    ) -> Result<Self> {
        match self.inner {
            Inner::Buffered(_) => {
                check_limit(limit, self.buffered()?.len(), resource)?;
                Ok(self)
            }
            Inner::Streaming { .. } | Inner::External(_) => {
                Ok(self.collect_within(limit, resource).await?.into())
            }
        }
    }

    /// The bytes of a buffered body, without copying.
    #[cfg_attr(
        not(any(
            feature = "quickjs",
            feature = "boa",
            feature = "v8",
            feature = "fuzzing",
            test
        )),
        allow(dead_code)
    )]
    pub(crate) fn into_bytes(self) -> Result<Bytes> {
        match self.inner {
            Inner::Buffered(data) => Ok(data.unwrap_or_default()),
            Inner::Streaming { .. } | Inner::External(_) => Err(Error::InvalidRequest(
                "a streaming body must be collected before this operation".into(),
            )),
        }
    }

    /// The bytes of a buffered body. Streaming bodies are collected first.
    pub(crate) fn buffered(&self) -> Result<&[u8]> {
        match &self.inner {
            Inner::Buffered(data) => Ok(data.as_deref().unwrap_or_default()),
            Inner::Streaming { .. } | Inner::External(_) => Err(Error::InvalidRequest(
                "a streaming body must be collected before this operation".into(),
            )),
        }
    }
}

impl From<Bytes> for Body {
    fn from(data: Bytes) -> Self {
        Self {
            inner: Inner::Buffered((!data.is_empty()).then_some(data)),
        }
    }
}

impl From<Vec<u8>> for Body {
    fn from(data: Vec<u8>) -> Self {
        Bytes::from(data).into()
    }
}

impl From<String> for Body {
    fn from(data: String) -> Self {
        Bytes::from(data).into()
    }
}

impl From<&'static str> for Body {
    fn from(data: &'static str) -> Self {
        Bytes::from_static(data.as_bytes()).into()
    }
}

impl http_body::Body for Body {
    type Data = Bytes;

    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>>>> {
        match &mut self.get_mut().inner {
            Inner::Buffered(data) => Poll::Ready(data.take().map(|data| Ok(Frame::data(data)))),
            Inner::Streaming {
                prefix,
                receiver,
                finished,
            } => {
                if let Some(prefix) = prefix.take() {
                    return Poll::Ready(Some(Ok(Frame::data(prefix))));
                }
                loop {
                    if *finished {
                        return Poll::Ready(None);
                    }
                    match receiver.poll_recv(context) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(None) => {
                            *finished = true;
                            return Poll::Ready(Some(Err(Error::InvocationClosed)));
                        }
                        Poll::Ready(Some(Err(error))) => {
                            *finished = true;
                            return Poll::Ready(Some(Err(error)));
                        }
                        Poll::Ready(Some(Ok((chunk, last)))) => {
                            *finished = last;
                            if !chunk.is_empty() {
                                return Poll::Ready(Some(Ok(Frame::data(chunk))));
                            }
                        }
                    }
                }
            }
            Inner::External(ExternalBody(body)) => loop {
                // Trailers are not part of the Fetch body.
                match body.as_mut().poll_frame(context) {
                    Poll::Ready(Some(Ok(frame))) if !frame.is_data() => continue,
                    other => return other,
                }
            },
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.inner {
            Inner::Buffered(data) => data.is_none(),
            Inner::Streaming {
                prefix, finished, ..
            } => prefix.is_none() && *finished,
            Inner::External(ExternalBody(body)) => body.is_end_stream(),
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.inner {
            Inner::Buffered(data) => {
                SizeHint::with_exact(data.as_ref().map_or(0, |data| data.len() as u64))
            }
            Inner::Streaming { .. } => SizeHint::default(),
            Inner::External(ExternalBody(body)) => body.size_hint(),
        }
    }
}

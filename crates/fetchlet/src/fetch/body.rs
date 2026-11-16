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
    not(any(feature = "quickjs", feature = "boa", feature = "v8")),
    allow(dead_code)
)]
pub(crate) type BodySender = mpsc::Sender<BodyChunk>;

/// An HTTP body owned by fetchlet.
///
/// A body is either buffered or streamed from the worker that owns the
/// JavaScript invocation. Streaming bodies hold that invocation's lease until
/// they finish or are dropped; dropping one cancels the JavaScript stream.
#[derive(Debug, Default)]
pub struct Body {
    inner: Inner,
}

#[cfg_attr(
    not(any(feature = "quickjs", feature = "boa", feature = "v8")),
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
        not(any(feature = "quickjs", feature = "boa", feature = "v8", test)),
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
            Inner::Streaming { .. } => Ok(self.collect_within(limit, resource).await?.into()),
        }
    }

    /// The bytes of a buffered body. Streaming bodies are collected first.
    pub(crate) fn buffered(&self) -> Result<&[u8]> {
        match &self.inner {
            Inner::Buffered(data) => Ok(data.as_deref().unwrap_or_default()),
            Inner::Streaming { .. } => Err(Error::InvalidRequest(
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
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.inner {
            Inner::Buffered(data) => data.is_none(),
            Inner::Streaming {
                prefix, finished, ..
            } => prefix.is_none() && *finished,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.inner {
            Inner::Buffered(data) => {
                SizeHint::with_exact(data.as_ref().map_or(0, |data| data.len() as u64))
            }
            Inner::Streaming { .. } => SizeHint::default(),
        }
    }
}

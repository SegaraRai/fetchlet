use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body::{Frame, SizeHint};

use crate::{Error, Result};

/// An HTTP body owned by fetchlet.
///
/// Currently buffered. The `http_body::Body` boundary allows a worker-backed
/// stream to be added without making callers depend on a byte-vector response.
#[derive(Debug, Default)]
pub struct Body {
    data: Option<Bytes>,
}

impl Body {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Collect the body, rejecting a result larger than `limit` bytes.
    pub async fn collect(self, limit: usize) -> Result<Bytes> {
        let data = self.data.unwrap_or_default();
        if data.len() > limit {
            return Err(Error::LimitExceeded("body bytes"));
        }
        Ok(data)
    }

    pub(crate) fn buffered(&self) -> &[u8] {
        self.data.as_deref().unwrap_or_default()
    }
}

impl From<Bytes> for Body {
    fn from(data: Bytes) -> Self {
        Self {
            data: (!data.is_empty()).then_some(data),
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
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>>>> {
        Poll::Ready(self.data.take().map(|data| Ok(Frame::data(data))))
    }

    fn is_end_stream(&self) -> bool {
        self.data.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.buffered().len() as u64)
    }
}

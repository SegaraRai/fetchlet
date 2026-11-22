use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Bytes, BytesMut};
use http_body::Body as _;

use crate::config::check_limit;
use crate::{Body, Error, Result};

/// A Rust body that JavaScript in the current invocation reads on demand.
///
/// Rust opens each one for the invocation's request or a host fetch response,
/// so their number is bounded by those, not by the guest. Dropping the
/// source drops the body, which cancels its producer.
pub(super) struct BodySource {
    body: Body,
    received: usize,
    limit: Option<usize>,
    resource: &'static str,
    /// Chunks a whole-body read has taken so far.
    collected: Vec<Bytes>,
}

pub(super) enum BodyRead {
    Chunk(Bytes),
    Done,
}

impl BodySource {
    pub fn new(body: Body, limit: Option<usize>, resource: &'static str) -> Self {
        Self {
            body,
            received: 0,
            limit,
            resource,
            collected: Vec::new(),
        }
    }

    /// The rest of the body as one buffer, counted against the body budget.
    ///
    /// Chunks taken before the body ends stay in the source, so a pending
    /// read resumes where it stopped and dropping the source releases them.
    pub fn poll_read_all(&mut self, context: &mut Context<'_>) -> Poll<Result<Bytes>> {
        loop {
            match self.poll_read(context) {
                Poll::Pending => {
                    return Poll::Pending;
                }
                Poll::Ready(Err(error)) => {
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(BodyRead::Chunk(chunk))) => {
                    self.collected.push(chunk);
                }
                Poll::Ready(Ok(BodyRead::Done)) => {
                    return Poll::Ready(Ok(concat(std::mem::take(&mut self.collected))));
                }
            }
        }
    }

    /// The next non-empty data chunk, counted against the body budget.
    pub fn poll_read(&mut self, context: &mut Context<'_>) -> Poll<Result<BodyRead>> {
        loop {
            let frame = match Pin::new(&mut self.body).poll_frame(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => return Poll::Ready(Ok(BodyRead::Done)),
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(Some(Ok(frame))) => frame,
            };
            // Trailers are not part of the Fetch body.
            let Ok(chunk) = frame.into_data() else {
                continue;
            };
            if chunk.is_empty() {
                continue;
            }
            return Poll::Ready(self.count(chunk.len()).map(|()| BodyRead::Chunk(chunk)));
        }
    }

    fn count(&mut self, length: usize) -> Result<()> {
        self.received = self
            .received
            .checked_add(length)
            .ok_or(Error::LimitExceeded(self.resource))?;
        check_limit(self.limit, self.received, self.resource)
    }
}

fn concat(mut chunks: Vec<Bytes>) -> Bytes {
    if chunks.len() <= 1 {
        return chunks.pop().unwrap_or_default();
    }
    let mut bytes = BytesMut::with_capacity(chunks.iter().map(Bytes::len).sum());
    for chunk in chunks {
        bytes.extend_from_slice(&chunk);
    }
    bytes.freeze()
}

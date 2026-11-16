use std::collections::BTreeMap;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body::Body as _;

use crate::config::check_limit;
use crate::{Body, Error, Result};

/// A Rust body that JavaScript in the current invocation reads on demand.
///
/// Dropping the source drops the body, which cancels its producer.
pub(super) struct BodySource {
    body: Body,
    received: usize,
    limit: Option<usize>,
    resource: &'static str,
}

/// The body sources of one invocation, by id.
///
/// Rust opens each one for the invocation's request or a host fetch response,
/// so their number is bounded by those, not by the guest.
#[derive(Default)]
pub(super) struct BodySources {
    next: u64,
    sources: BTreeMap<u64, BodySource>,
}

impl BodySources {
    pub fn open(
        &mut self,
        body: Body,
        limit: Option<usize>,
        resource: &'static str,
    ) -> Result<u64> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or(Error::LimitExceeded("body sources"))?;
        self.sources
            .insert(self.next, BodySource::new(body, limit, resource));
        Ok(self.next)
    }

    pub fn contains(&self, id: u64) -> bool {
        self.sources.contains_key(&id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut BodySource> {
        self.sources.get_mut(&id)
    }

    /// Dropping the source cancels the body's producer.
    pub fn remove(&mut self, id: u64) {
        self.sources.remove(&id);
    }
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

//! Request bodies JavaScript streams to an outbound fetch: the transport
//! reads the body as it sends it, and each read it waits on asks JavaScript
//! for the next chunk at the next host step.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};

use bytes::Bytes;
use http_body::{Frame, SizeHint};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::config::check_limit;
use crate::execution::WakeSignal;
use crate::{Body, Error, Result};

/// What JavaScript writes to an upload: its next chunk, its end, or a
/// failure of its stream.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UploadWrite {
    pub ticket: String,
    #[serde(default)]
    pub chunk: Option<u64>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub error: bool,
}

/// Where an upload stands.
enum Stream {
    /// More chunks may come.
    Open,
    /// JavaScript wrote the last chunk.
    Done,
    /// The upload failed.
    Failed(Failure),
    /// The transport dropped the body, so JavaScript should stop.
    Cancelled,
}

#[derive(Clone, Copy)]
enum Failure {
    /// The JavaScript stream errored or produced something not bytes.
    Stream,
    /// JavaScript wrote more chunks than `Limits::request_body_chunks`.
    Chunks,
    /// The invocation ended before the body did.
    Closed,
}

impl Failure {
    fn error(self) -> Error {
        match self {
            Self::Stream => Error::Transport("the request body stream failed".into()),
            Self::Chunks => Error::LimitExceeded("request body chunks"),
            Self::Closed => Error::InvocationClosed,
        }
    }
}

struct Shared {
    stream: Stream,
    /// The chunk JavaScript wrote and the transport has not read.
    chunk: Option<Bytes>,
    /// The transport waits for a chunk.
    wanted: bool,
    /// JavaScript was asked for the chunk the transport waits for.
    requested: bool,
    chunks: usize,
    consumer: Option<Waker>,
    wake: WakeSignal,
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|error| error.into_inner())
}

/// The body the transport reads. Dropping it cancels the JavaScript stream.
struct UploadBody(Arc<Mutex<Shared>>);

impl http_body::Body for UploadBody {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>>>> {
        let mut shared = lock(&self.0);
        if let Some(chunk) = shared.chunk.take() {
            return Poll::Ready(Some(Ok(Frame::data(chunk))));
        }
        match &shared.stream {
            Stream::Done => return Poll::Ready(None),
            Stream::Failed(failure) => return Poll::Ready(Some(Err(failure.error()))),
            Stream::Cancelled => return Poll::Ready(Some(Err(Error::InvocationClosed))),
            Stream::Open => {}
        }
        shared.consumer = Some(context.waker().clone());
        if !shared.wanted {
            shared.wanted = true;
            shared.wake.notify();
        }
        Poll::Pending
    }

    fn is_end_stream(&self) -> bool {
        let shared = lock(&self.0);
        shared.chunk.is_none() && matches!(shared.stream, Stream::Done)
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

impl Drop for UploadBody {
    fn drop(&mut self) {
        let mut shared = lock(&self.0);
        if matches!(shared.stream, Stream::Open) {
            shared.stream = Stream::Cancelled;
            shared.wake.notify();
        }
    }
}

/// The uploads of an invocation, by ticket.
#[derive(Default)]
pub(super) struct Uploads {
    uploads: BTreeMap<String, Arc<Mutex<Shared>>>,
}

impl Uploads {
    /// A body the transport reads from JavaScript, under `ticket`.
    pub fn open(&mut self, ticket: String, wake: WakeSignal) -> Body {
        let shared = Arc::new(Mutex::new(Shared {
            stream: Stream::Open,
            chunk: None,
            wanted: false,
            requested: false,
            chunks: 0,
            consumer: None,
            wake,
        }));
        self.uploads.insert(ticket, shared.clone());
        Body::from_fetchlet_body(UploadBody(shared))
    }

    /// Ask JavaScript for each chunk a transport waits on, and tell it to
    /// stop each upload whose transport went away: `{ id, result }` events
    /// whose value is `"pull"` or `"cancel"`.
    pub fn poll(&mut self, events: &mut Vec<Value>) {
        self.uploads.retain(|ticket, shared| {
            let mut shared = lock(shared);
            match shared.stream {
                Stream::Cancelled => {
                    events
                        .push(json!({ "id": ticket, "result": { "ok": true, "value": "cancel" } }));
                    false
                }
                Stream::Open if shared.wanted && !shared.requested => {
                    shared.requested = true;
                    events.push(json!({ "id": ticket, "result": { "ok": true, "value": "pull" } }));
                    true
                }
                Stream::Open => true,
                Stream::Done | Stream::Failed(_) => false,
            }
        });
    }

    /// Take what JavaScript wrote. A chunk answers the last pull; more
    /// than `chunk_limit` chunks fail the upload.
    pub fn write(
        &mut self,
        write: UploadWrite,
        chunk: Option<Bytes>,
        chunk_limit: Option<usize>,
    ) -> Result<Value> {
        let shared = self
            .uploads
            .get(&write.ticket)
            .ok_or(Error::InvocationClosed)?
            .clone();
        let mut shared = lock(&shared);
        if !matches!(shared.stream, Stream::Open) {
            return Err(Error::InvocationClosed);
        }
        if !shared.requested || shared.chunk.is_some() {
            return Err(Error::InvalidRequest(
                "an upload chunk was not asked for".into(),
            ));
        }
        let result = if write.error {
            shared.stream = Stream::Failed(Failure::Stream);
            Ok(Value::Null)
        } else if write.done {
            shared.stream = Stream::Done;
            Ok(Value::Null)
        } else if let Some(chunk) = chunk {
            shared.chunks += 1;
            match check_limit(chunk_limit, shared.chunks, "request body chunks") {
                Ok(()) => {
                    shared.chunk = Some(chunk);
                    Ok(Value::Null)
                }
                Err(error) => {
                    shared.stream = Stream::Failed(Failure::Chunks);
                    Err(error)
                }
            }
        } else {
            return Err(Error::InvalidRequest(
                "an upload write needs a chunk".into(),
            ));
        };
        shared.wanted = false;
        shared.requested = false;
        if let Some(consumer) = shared.consumer.take() {
            consumer.wake();
        }
        if !matches!(shared.stream, Stream::Open) {
            drop(shared);
            self.uploads.remove(&write.ticket);
        }
        result
    }
}

impl Drop for Uploads {
    fn drop(&mut self) {
        // The invocation ended: a transport still reading fails.
        for shared in self.uploads.values() {
            let mut shared = lock(shared);
            if matches!(shared.stream, Stream::Open) {
                shared.stream = Stream::Failed(Failure::Closed);
                if let Some(consumer) = shared.consumer.take() {
                    consumer.wake();
                }
            }
        }
    }
}

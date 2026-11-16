use std::collections::BTreeMap;

use bytes::Bytes;
use serde::{Deserialize, Serialize};

use crate::{Body, Error, Result};

/// Body bytes in a bridge message.
///
/// Engines with a byte store exchange a handle, so bodies cross the bridge as
/// native typed arrays instead of JSON. Inline number arrays remain the
/// representation for calls that have no invocation store (`FetchApp`), and
/// are accepted from handlers that build wire messages by hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum WireBytes {
    Handle(u64),
    Inline(Vec<u8>),
}

impl Default for WireBytes {
    fn default() -> Self {
        Self::Inline(Vec::new())
    }
}

/// How a body that is not in memory reaches JavaScript.
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
pub(crate) enum BodyTransfer {
    /// JavaScript reads the body on demand through this body source id.
    Stream(u64),
    /// The conversion collects the body and sends its bytes.
    Collect(Body),
}

/// How a wire conversion moves body bytes across the bridge.
pub(crate) trait ByteTransport {
    /// Make bytes available to JavaScript.
    fn send(&mut self, bytes: Bytes) -> Result<WireBytes>;
    /// Resolve bytes that JavaScript produced.
    fn receive(&mut self, bytes: WireBytes) -> Result<Bytes>;
    /// Offer a body to JavaScript as a stream. Transports without an
    /// invocation collect it instead.
    fn stream(
        &mut self,
        body: Body,
        _limit: Option<usize>,
        _resource: &'static str,
    ) -> Result<BodyTransfer> {
        Ok(BodyTransfer::Collect(body))
    }
}

/// Inline JSON arrays only, for calls without an invocation byte store.
pub(crate) struct InlineBytes;

impl ByteTransport for InlineBytes {
    fn send(&mut self, bytes: Bytes) -> Result<WireBytes> {
        Ok(WireBytes::Inline(bytes.to_vec()))
    }

    fn receive(&mut self, bytes: WireBytes) -> Result<Bytes> {
        match bytes {
            WireBytes::Inline(bytes) => Ok(bytes.into()),
            WireBytes::Handle(_) => Err(Error::InvalidRequest(
                "byte handles need an invocation byte store".into(),
            )),
        }
    }
}

/// Byte buffers in transit between Rust and JavaScript within one invocation.
///
/// Each buffer is taken once by the other side. The store belongs to the
/// invocation and is dropped with it, so handles never cross invocations.
///
/// JavaScript stores a buffer right before the bridge message that carries its
/// handle, so at most one guest buffer waits at a time: storing another drops
/// an untaken one. Guest code therefore cannot keep memory outside the engine
/// heap. Buffers from Rust are bounded by the body budgets of their sources.
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
#[derive(Default)]
pub(crate) struct ByteStore {
    next: u64,
    buffers: BTreeMap<u64, Bytes>,
    guest: Option<u64>,
}

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
impl ByteStore {
    pub fn put(&mut self, bytes: Bytes) -> Result<u64> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or(Error::LimitExceeded("byte handles"))?;
        self.buffers.insert(self.next, bytes);
        Ok(self.next)
    }

    /// Store a buffer from JavaScript, replacing its untaken predecessor.
    pub fn put_guest(&mut self, bytes: Bytes) -> Result<u64> {
        if let Some(previous) = self.guest.take() {
            self.buffers.remove(&previous);
        }
        let handle = self.put(bytes)?;
        self.guest = Some(handle);
        Ok(handle)
    }

    pub fn take(&mut self, handle: u64) -> Result<Bytes> {
        self.buffers
            .remove(&handle)
            .ok_or_else(|| Error::InvalidRequest("unknown byte handle".into()))
    }
}

impl ByteTransport for ByteStore {
    fn send(&mut self, bytes: Bytes) -> Result<WireBytes> {
        self.put(bytes).map(WireBytes::Handle)
    }

    fn receive(&mut self, bytes: WireBytes) -> Result<Bytes> {
        match bytes {
            WireBytes::Handle(handle) => self.take(handle),
            WireBytes::Inline(bytes) => Ok(bytes.into()),
        }
    }
}

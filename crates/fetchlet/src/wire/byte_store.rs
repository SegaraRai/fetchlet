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

/// How a wire conversion moves body bytes across the bridge: inline in the
/// JSON ([`InlineBytes`]), or by handles into an invocation's byte store.
pub(crate) trait BridgeBytes {
    /// Make bytes available to JavaScript.
    fn send(&mut self, bytes: Bytes) -> Result<WireBytes>;
    /// Resolve bytes that JavaScript produced.
    fn receive(&mut self, bytes: WireBytes) -> Result<Bytes>;
    /// Offer a body to JavaScript as a stream. Without an invocation,
    /// the conversion collects it instead.
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

impl BridgeBytes for InlineBytes {
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

/// The first handle of the range an isolated instance's child picks its
/// buffers' handles from, so that it need not wait for the parent to assign
/// one (`ByteStore::put_guest_at`). The store's own handles stay below it,
/// and every handle stays below 2^53, exact in a JavaScript number.
pub(crate) const GUEST_HANDLES_START: u64 = 1 << 52;

/// The end of the guest handle range, exclusive.
pub(crate) const GUEST_HANDLES_END: u64 = 1 << 53;

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
            .filter(|next| *next < GUEST_HANDLES_START)
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

    /// Store a buffer from JavaScript under the handle an isolated
    /// instance's child picked from the guest range, replacing its untaken
    /// predecessor as `put_guest` does.
    #[cfg_attr(not(fetchlet_process), allow(dead_code))]
    pub fn put_guest_at(&mut self, handle: u64, bytes: Bytes) -> Result<()> {
        if !(GUEST_HANDLES_START..GUEST_HANDLES_END).contains(&handle)
            || self.buffers.contains_key(&handle)
        {
            return Err(Error::InvalidRequest("invalid byte handle".into()));
        }
        if let Some(previous) = self.guest.take() {
            self.buffers.remove(&previous);
        }
        self.buffers.insert(handle, bytes);
        self.guest = Some(handle);
        Ok(())
    }

    pub fn take(&mut self, handle: u64) -> Result<Bytes> {
        self.buffers
            .remove(&handle)
            .ok_or_else(|| Error::InvalidRequest("unknown byte handle".into()))
    }
}

impl BridgeBytes for ByteStore {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_never_reused_once_exhausted() {
        let last = GUEST_HANDLES_START - 1;
        let mut store = ByteStore {
            next: last - 1,
            ..ByteStore::default()
        };
        assert_eq!(store.put(Bytes::new()).unwrap(), last);
        assert!(matches!(
            store.put(Bytes::new()),
            Err(Error::LimitExceeded("byte handles"))
        ));
        assert!(matches!(
            store.put_guest(Bytes::new()),
            Err(Error::LimitExceeded("byte handles"))
        ));
        assert!(store.take(last).is_ok());
    }

    #[test]
    fn a_child_picks_guest_handles_within_the_guest_range_once() {
        let mut store = ByteStore::default();
        let first = GUEST_HANDLES_START;
        store.put_guest_at(first, Bytes::from_static(b"a")).unwrap();
        // The same handle again, or one outside the range, is refused.
        for handle in [first, 0, 1, GUEST_HANDLES_START - 1, GUEST_HANDLES_END] {
            assert!(matches!(
                store.put_guest_at(handle, Bytes::new()),
                Err(Error::InvalidRequest(_))
            ));
        }
        // A later buffer replaces the untaken one, as `put_guest` does.
        store
            .put_guest_at(first + 1, Bytes::from_static(b"b"))
            .unwrap();
        assert!(store.take(first).is_err());
        assert_eq!(store.take(first + 1).unwrap(), Bytes::from_static(b"b"));
    }
}

mod byte_store;
mod codec;

pub(crate) use byte_store::InlineBytes;
pub(crate) use codec::{WireRequest, WireResponse, normalize_fetch_method, validate_headers};

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use byte_store::{BodyTransfer, BridgeBytes, ByteStore, WireBytes};
#[cfg(fetchlet_process)]
pub(crate) use byte_store::{GUEST_HANDLES_END, GUEST_HANDLES_START};

#[cfg(test)]
mod tests;

mod byte_store;
mod codec;

pub(crate) use byte_store::InlineBytes;
pub(crate) use codec::{WireRequest, WireResponse, normalize_fetch_method, validate_headers};

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8", test))]
pub(crate) use byte_store::{BodyTransfer, ByteStore, ByteTransport, WireBytes};

#[cfg(test)]
mod tests;

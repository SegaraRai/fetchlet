use crate::{Error, Result};

/// Caller budgets for Web API operations. Each is unlimited when `None`;
/// the embedder owns the values and documents them with its other limits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WebLimits {
    /// Bytes one `crypto.subtle.digest` call hashes.
    pub digest_bytes: Option<usize>,
    /// `CompressionStream` and `DecompressionStream` instances open at once
    /// in an invocation.
    pub compression_streams: Option<usize>,
    /// Bytes one `DecompressionStream` produces.
    pub decompressed_bytes: Option<usize>,
}

#[cfg_attr(
    not(any(feature = "compression", feature = "crypto")),
    allow(dead_code)
)]
pub(crate) fn check_limit(
    limit: Option<usize>,
    observed: usize,
    resource: &'static str,
) -> Result<()> {
    if limit.is_some_and(|limit| observed > limit) {
        return Err(Error::LimitExceeded(resource));
    }
    Ok(())
}

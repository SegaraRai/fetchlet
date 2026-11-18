use crate::{Error, Result};

/// Caller budgets for Web API operations. Each is unlimited when `None`;
/// the embedder owns the values and documents them with its other limits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WebLimits {
    /// Bytes one `crypto.subtle.digest` call, or one `node:crypto` hash or
    /// HMAC, hashes.
    pub digest_bytes: Option<usize>,
    /// `CompressionStream` and `DecompressionStream` instances open at once
    /// in an invocation.
    pub compression_streams: Option<usize>,
    /// Bytes one `DecompressionStream` produces.
    pub decompressed_bytes: Option<usize>,
    /// Modulus length of a generated RSA key, in bits, which bounds the
    /// time key generation takes.
    pub rsa_modulus_bits: Option<usize>,
    /// Iterations of one PBKDF2 derivation.
    pub pbkdf2_iterations: Option<usize>,
    /// Working memory of one `node:crypto` scrypt derivation, 128 * N * r
    /// bytes, which the host allocates.
    pub scrypt_memory_bytes: Option<usize>,
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

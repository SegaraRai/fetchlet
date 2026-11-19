//! HMAC (RFC 2104) keys and signatures.

use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};

use super::digest::{Hash, with_hash};
use super::message::{Algorithm, Failure, Key, Outcome};
use super::random::fill;
use super::secret::{Exported, Format, oct_jwk, read_oct_jwk};
use crate::limits::zeroed;

/// A random key of `length` bits, or of the hash's block size.
pub(super) fn generate(algorithm: &Algorithm) -> Outcome<(Key, Value)> {
    let hash = Hash::parse(algorithm.hash.as_deref())?;
    let length = match algorithm.length {
        Some(0) => return Err(Failure::operation("the HMAC key length is zero")),
        Some(length) => length,
        None => hash.block_bits(),
    };
    let mut bytes = zeroed(length.div_ceil(8) as usize)
        .map_err(|_| Failure::operation("the HMAC key does not fit in memory"))?;
    fill(&mut bytes)?;
    Ok((Key::secret(bytes), json!({ "length": length })))
}

pub(super) fn import(
    algorithm: &Algorithm,
    format: Format,
    data: Vec<u8>,
    jwk: Option<&Value>,
) -> Outcome<(Key, Value)> {
    Hash::parse(algorithm.hash.as_deref())?;
    let data = match (format, jwk) {
        (Format::Raw, _) => data,
        (Format::Jwk, Some(jwk)) => read_oct_jwk(jwk)?,
        _ => return Err(Failure::not_supported("HMAC keys import as raw or jwk")),
    };
    let bits = u32::try_from(data.len() * 8).map_err(|_| Failure::data("the key is too long"))?;
    if bits == 0 {
        return Err(Failure::data("the HMAC key is empty"));
    }
    let length = match algorithm.length {
        Some(length) if length == 0 || length > bits || length <= bits - 8 => {
            return Err(Failure::data("the length does not match the key data"));
        }
        Some(length) => length,
        None => bits,
    };
    Ok((Key::secret(data), json!({ "length": length })))
}

pub(super) fn export(format: Format, key: &Key) -> Outcome<Exported> {
    match format {
        Format::Raw => Ok(Exported::Raw(key.data.to_vec())),
        Format::Jwk => Ok(Exported::Jwk(oct_jwk(&key.data))),
        _ => Err(Failure::not_supported("HMAC keys export as raw or jwk")),
    }
}

pub(super) fn sign(key_algorithm: &Algorithm, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    let hash = Hash::parse(key_algorithm.hash.as_deref())?;
    with_hash!(hash, D => {
        let mut mac = <Hmac<D> as KeyInit>::new_from_slice(&key.data)
            .map_err(|_| Failure::operation("invalid HMAC key"))?;
        mac.update(data);
        Ok(mac.finalize().into_bytes().to_vec())
    })
}

/// Compares in constant time.
pub(super) fn verify(
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
    signature: &[u8],
) -> Outcome<bool> {
    let hash = Hash::parse(key_algorithm.hash.as_deref())?;
    with_hash!(hash, D => {
        let mut mac = <Hmac<D> as KeyInit>::new_from_slice(&key.data)
            .map_err(|_| Failure::operation("invalid HMAC key"))?;
        mac.update(data);
        Ok(mac.verify_slice(signature).is_ok())
    })
}

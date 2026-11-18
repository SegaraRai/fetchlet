//! HKDF (RFC 5869) and PBKDF2 (RFC 8018) key derivation.

use hkdf::Hkdf;
use serde_json::{Value, json};

use super::digest::{Hash, with_hash};
use super::message::{Algorithm, Failure, Key, Outcome};
use super::secret::Format;

/// Base keys import as raw bytes only.
pub(super) fn import(format: Format, data: Vec<u8>) -> Outcome<(Key, Value)> {
    if format != Format::Raw {
        return Err(Failure::not_supported("derivation keys import as raw"));
    }
    Ok((Key::secret(data), json!({})))
}

/// `length` bits, which must be whole bytes.
pub(super) fn derive_bits(
    algorithm: &Algorithm,
    key: &Key,
    length: Option<u32>,
) -> Outcome<Vec<u8>> {
    let length = length.ok_or_else(|| Failure::operation("the length is null"))?;
    if !length.is_multiple_of(8) {
        return Err(Failure::operation("the length is not whole bytes"));
    }
    let hash = Hash::parse(algorithm.hash.as_deref())?;
    let mut output = vec![0; length as usize / 8];
    if output.is_empty() {
        return Ok(output);
    }
    let salt = algorithm.salt.as_deref().unwrap_or_default();
    match algorithm.name.as_str() {
        "HKDF" => {
            let info = algorithm.info.as_deref().unwrap_or_default();
            with_hash!(hash, D => Hkdf::<D>::new(Some(salt), &key.data)
                .expand(info, &mut output)
                .map_err(|_| Failure::operation("the HKDF output is too long")))?;
        }
        "PBKDF2" => {
            let iterations = algorithm.iterations.unwrap_or(0);
            if iterations == 0 {
                return Err(Failure::operation("PBKDF2 needs at least one iteration"));
            }
            with_hash!(hash, D => pbkdf2::pbkdf2_hmac::<D>(&key.data, salt, iterations, &mut output));
        }
        name => {
            return Err(Failure::not_supported(format!(
                "{name} does not derive bits"
            )));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::message::Bytes;

    #[test]
    fn hkdf_and_pbkdf2_match_their_rfc_vectors() {
        // RFC 5869 A.1.
        let algorithm = Algorithm {
            name: "HKDF".into(),
            hash: Some("SHA-256".into()),
            salt: Some(Bytes((0..=12).collect())),
            info: Some(Bytes((0xf0..=0xf9).collect())),
            ..Algorithm::default()
        };
        let okm = derive_bits(&algorithm, &Key::secret(vec![0x0b; 22]), Some(42 * 8)).unwrap();
        assert_eq!(&okm[..4], &[0x3c, 0xb2, 0x5f, 0x25]);
        // RFC 6070, one iteration.
        let algorithm = Algorithm {
            name: "PBKDF2".into(),
            hash: Some("SHA-1".into()),
            salt: Some(Bytes(b"salt".to_vec())),
            iterations: Some(1),
            ..Algorithm::default()
        };
        let key = Key::secret(b"password".to_vec());
        let derived = derive_bits(&algorithm, &key, Some(160)).unwrap();
        assert_eq!(&derived[..4], &[0x0c, 0x60, 0xc8, 0x0f]);
        assert!(derive_bits(&algorithm, &key, None).is_err());
        assert!(derive_bits(&algorithm, &key, Some(12)).is_err());
    }
}

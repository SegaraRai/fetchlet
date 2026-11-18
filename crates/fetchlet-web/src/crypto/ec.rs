//! NIST P-256, P-384 and P-521 keys (FIPS 186-5) for ECDSA and ECDH.

use serde_json::{Value, json};

use super::digest::{Hash, digest};
use super::message::{Algorithm, Failure, Key, KeyType, Outcome, jwk_bytes, jwk_text};
use super::random::fill;
use super::secret::{Exported, Format};

/// The operations of one curve, from its RustCrypto crate.
macro_rules! curve {
    ($module:ident, $krate:ident, $name:literal) => {
        mod $module {
            use $krate::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
            use $krate::ecdsa::{Signature, SigningKey, VerifyingKey};
            use $krate::elliptic_curve::sec1::ToSec1Point;
            use $krate::pkcs8::{
                DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey,
            };
            use $krate::{FieldBytes, PublicKey, SecretKey};

            use super::*;

            const SIZE: usize = std::mem::size_of::<FieldBytes>();

            fn public_key(key: &PublicKey) -> Outcome<Key> {
                let der = key
                    .to_public_key_der()
                    .map_err(|_| Failure::operation("the public key cannot be encoded"))?;
                Ok(Key::public(der.as_bytes().to_vec()))
            }

            fn private_key(key: &SecretKey) -> Outcome<Key> {
                let der = key
                    .to_pkcs8_der()
                    .map_err(|_| Failure::operation("the private key cannot be encoded"))?;
                Ok(Key::private(der.as_bytes().to_vec()))
            }

            fn decode_public(key: &Key) -> Outcome<PublicKey> {
                match key.kind {
                    KeyType::Public => PublicKey::from_public_key_der(&key.data)
                        .map_err(|_| Failure::operation("invalid public key")),
                    _ => Err(Failure::invalid_access("the key is not a public key")),
                }
            }

            fn decode_private(key: &Key) -> Outcome<SecretKey> {
                match key.kind {
                    KeyType::Private => SecretKey::from_pkcs8_der(&key.data)
                        .map_err(|_| Failure::operation("invalid private key")),
                    _ => Err(Failure::invalid_access("the key is not a private key")),
                }
            }

            /// A uniformly random scalar: random bytes, retried while they
            /// are not below the group order.
            pub(super) fn generate() -> Outcome<(Key, Key)> {
                let mut bytes = [0u8; SIZE];
                for _ in 0..64 {
                    fill(&mut bytes)?;
                    if SIZE == 66 {
                        // P-521 scalars have 521 bits; the top byte holds one.
                        bytes[0] &= 1;
                    }
                    if let Ok(secret) = SecretKey::from_slice(&bytes) {
                        return Ok((public_key(&secret.public_key())?, private_key(&secret)?));
                    }
                }
                Err(Failure::operation("no valid scalar was generated"))
            }

            pub(super) fn import(
                format: Format,
                data: &[u8],
                jwk: Option<&Value>,
            ) -> Outcome<Key> {
                match (format, jwk) {
                    (Format::Raw, _) => {
                        let key = PublicKey::from_sec1_bytes(data)
                            .map_err(|_| Failure::data("not a point on the curve"))?;
                        public_key(&key)
                    }
                    (Format::Spki, _) => {
                        let key = PublicKey::from_public_key_der(data)
                            .map_err(|_| Failure::data("not a SubjectPublicKeyInfo for the curve"))?;
                        public_key(&key)
                    }
                    (Format::Pkcs8, _) => {
                        let key = SecretKey::from_pkcs8_der(data)
                            .map_err(|_| Failure::data("not a PKCS #8 private key for the curve"))?;
                        private_key(&key)
                    }
                    (Format::Jwk, Some(jwk)) => {
                        let x = jwk_bytes(jwk, "x")?;
                        let y = jwk_bytes(jwk, "y")?;
                        if x.len() != SIZE || y.len() != SIZE {
                            return Err(Failure::data("the JWK coordinates have the wrong length"));
                        }
                        let point = [&[4u8][..], &x, &y].concat();
                        let public = PublicKey::from_sec1_bytes(&point)
                            .map_err(|_| Failure::data("the JWK is not a point on the curve"))?;
                        if jwk.get("d").is_none() {
                            return public_key(&public);
                        }
                        let d = jwk_bytes(jwk, "d")?;
                        if d.len() != SIZE {
                            return Err(Failure::data("the JWK d has the wrong length"));
                        }
                        let secret = SecretKey::from_slice(&d)
                            .map_err(|_| Failure::data("the JWK d is not a valid scalar"))?;
                        if secret.public_key() != public {
                            return Err(Failure::data("the JWK d does not match x and y"));
                        }
                        private_key(&secret)
                    }
                    _ => Err(Failure::not_supported("unsupported key format")),
                }
            }

            pub(super) fn export(format: Format, key: &Key) -> Outcome<Exported> {
                match (format, key.kind) {
                    (Format::Spki, KeyType::Public) | (Format::Pkcs8, KeyType::Private) => {
                        Ok(Exported::Raw(key.data.to_vec()))
                    }
                    (Format::Raw, KeyType::Public) => {
                        let point = decode_public(key)?.to_sec1_point(false);
                        Ok(Exported::Raw(point.as_bytes().to_vec()))
                    }
                    (Format::Jwk, kind) => {
                        let (public, d) = match kind {
                            KeyType::Private => {
                                let secret = decode_private(key)?;
                                (secret.public_key(), Some(secret.to_bytes()))
                            }
                            _ => (decode_public(key)?, None),
                        };
                        let point = public.to_sec1_point(false);
                        let coordinates = &point.as_bytes()[1..];
                        let mut jwk = json!({
                            "kty": "EC",
                            "crv": $name,
                            "x": jwk_text(&coordinates[..SIZE]),
                            "y": jwk_text(&coordinates[SIZE..]),
                        });
                        if let Some(d) = d {
                            jwk["d"] = jwk_text(&d).into();
                        }
                        Ok(Exported::Jwk(jwk))
                    }
                    _ => Err(Failure::invalid_access("the key cannot be exported in this format")),
                }
            }

            /// ECDSA over the prehashed message; the signature is r || s.
            pub(super) fn sign(hash: Hash, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
                let signer = SigningKey::from(&decode_private(key)?);
                let signature: Signature = signer
                    .sign_prehash(&digest(hash, data))
                    .map_err(|_| Failure::operation("ECDSA signing failed"))?;
                Ok(signature.to_bytes().to_vec())
            }

            pub(super) fn verify(
                hash: Hash,
                key: &Key,
                data: &[u8],
                signature: &[u8],
            ) -> Outcome<bool> {
                let verifier = VerifyingKey::from(&decode_public(key)?);
                let Ok(signature) = Signature::from_slice(signature) else {
                    return Ok(false);
                };
                Ok(verifier
                    .verify_prehash(&digest(hash, data), &signature)
                    .is_ok())
            }

            /// The x-coordinate of the shared point.
            pub(super) fn derive(key: &Key, public: &Key) -> Outcome<Vec<u8>> {
                let secret = decode_private(key)?;
                let public = decode_public(public)?;
                Ok(secret.diffie_hellman(&public).raw_secret_bytes().to_vec())
            }
        }
    };
}

curve!(p256_curve, p256, "P-256");
curve!(p384_curve, p384, "P-384");
curve!(p521_curve, p521, "P-521");

/// Evaluate `$body` with `$curve` bound to the operations of the curve.
macro_rules! with_curve {
    ($name:expr, $curve:ident => $body:expr) => {
        match $name {
            Some("P-256") => {
                use p256_curve as $curve;
                $body
            }
            Some("P-384") => {
                use p384_curve as $curve;
                $body
            }
            Some("P-521") => {
                use p521_curve as $curve;
                $body
            }
            _ => Err(Failure::not_supported("unsupported named curve")),
        }
    };
}

pub(super) fn generate(algorithm: &Algorithm) -> Outcome<(Key, Key, Value)> {
    let curve = algorithm.named_curve.as_deref();
    let (public, private) = with_curve!(curve, c => c::generate())?;
    Ok((public, private, json!({ "namedCurve": curve })))
}

/// The key's curve must be the algorithm's `namedCurve`.
pub(super) fn import(
    algorithm: &Algorithm,
    format: Format,
    data: Vec<u8>,
    jwk: Option<&Value>,
) -> Outcome<(Key, Value)> {
    let curve = algorithm.named_curve.as_deref();
    if let Some(jwk) = jwk {
        if jwk.get("kty").and_then(Value::as_str) != Some("EC") {
            return Err(Failure::data("the JWK kty is not EC"));
        }
        if jwk.get("crv").and_then(Value::as_str) != curve {
            return Err(Failure::data("the JWK crv is not the named curve"));
        }
    }
    let key = with_curve!(curve, c => c::import(format, &data, jwk))?;
    Ok((key, json!({ "namedCurve": curve })))
}

pub(super) fn export(key_algorithm: &Algorithm, format: Format, key: &Key) -> Outcome<Exported> {
    with_curve!(key_algorithm.named_curve.as_deref(), c => c::export(format, key))
}

pub(super) fn sign(
    algorithm: &Algorithm,
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let hash = Hash::parse(algorithm.hash.as_deref())?;
    with_curve!(key_algorithm.named_curve.as_deref(), c => c::sign(hash, key, data))
}

pub(super) fn verify(
    algorithm: &Algorithm,
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
    signature: &[u8],
) -> Outcome<bool> {
    let hash = Hash::parse(algorithm.hash.as_deref())?;
    with_curve!(key_algorithm.named_curve.as_deref(), c => c::verify(hash, key, data, signature))
}

/// ECDH: the shared secret, truncated to `length` bits when given.
pub(super) fn derive_bits(
    key_algorithm: &Algorithm,
    key: &Key,
    public: &Key,
    length: Option<u32>,
) -> Outcome<Vec<u8>> {
    let secret = with_curve!(key_algorithm.named_curve.as_deref(), c => c::derive(key, public))?;
    truncate(secret, length)
}

/// The first `length` bits of a shared secret, or all of it.
pub(super) fn truncate(mut secret: Vec<u8>, length: Option<u32>) -> Outcome<Vec<u8>> {
    let Some(length) = length else {
        return Ok(secret);
    };
    let length = length as usize;
    if length > secret.len() * 8 {
        return Err(Failure::operation("the length exceeds the shared secret"));
    }
    secret.truncate(length.div_ceil(8));
    if !length.is_multiple_of(8) {
        let last = secret.len() - 1;
        secret[last] &= 0xff << (8 - length % 8);
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn algorithm(name: &str, curve: &str, hash: Option<&str>) -> Algorithm {
        Algorithm {
            name: name.into(),
            named_curve: Some(curve.into()),
            hash: hash.map(Into::into),
            ..Algorithm::default()
        }
    }

    #[test]
    fn every_curve_signs_derives_and_round_trips_jwk() {
        for curve in ["P-256", "P-384", "P-521"] {
            let ecdsa = algorithm("ECDSA", curve, Some("SHA-256"));
            let (public, private, _) = generate(&ecdsa).unwrap();
            let signature = sign(&ecdsa, &ecdsa, &private, b"data").unwrap();
            assert!(verify(&ecdsa, &ecdsa, &public, b"data", &signature).unwrap());
            assert!(!verify(&ecdsa, &ecdsa, &public, b"other", &signature).unwrap());

            let Exported::Jwk(jwk) = export(&ecdsa, Format::Jwk, &private).unwrap() else {
                panic!("a JWK");
            };
            let (imported, _) = import(&ecdsa, Format::Jwk, Vec::new(), Some(&jwk)).unwrap();
            assert_eq!(imported.data, private.data);
            let Exported::Raw(raw) = export(&ecdsa, Format::Raw, &public).unwrap() else {
                panic!("raw bytes");
            };
            assert_eq!(
                import(&ecdsa, Format::Raw, raw, None).unwrap().0.data,
                public.data
            );

            let (other_public, other_private, _) = generate(&ecdsa).unwrap();
            let ours = derive_bits(&ecdsa, &private, &other_public, None).unwrap();
            let theirs = derive_bits(&ecdsa, &other_private, &public, None).unwrap();
            assert_eq!(ours, theirs);
        }
        let mismatched = algorithm("ECDSA", "P-384", Some("SHA-256"));
        let (_, private, _) = generate(&algorithm("ECDSA", "P-256", None)).unwrap();
        let Exported::Raw(pkcs8) = export(&mismatched, Format::Pkcs8, &private).unwrap() else {
            panic!("raw bytes");
        };
        assert_eq!(
            import(&mismatched, Format::Pkcs8, pkcs8, None)
                .unwrap_err()
                .name,
            "DataError"
        );
    }

    #[test]
    fn truncates_to_whole_and_partial_bytes() {
        assert_eq!(
            truncate(vec![0xff, 0xff], Some(12)).unwrap(),
            vec![0xff, 0xf0]
        );
        assert_eq!(truncate(vec![1, 2], None).unwrap(), vec![1, 2]);
        assert!(truncate(vec![1, 2], Some(17)).is_err());
    }
}

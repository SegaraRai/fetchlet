//! Ed25519 signatures and X25519 key agreement (RFC 8032, RFC 7748), with
//! the key encodings of RFC 8410.

use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use pkcs8::der::Decode;
use pkcs8::der::asn1::OctetString;
use pkcs8::{ObjectIdentifier, PrivateKeyInfoRef};
use serde_json::{Value, json};
use spki::SubjectPublicKeyInfoRef;
use x25519_dalek::{PublicKey as X25519Public, StaticSecret};

use super::ec::truncate;
use super::message::{Failure, Key, KeyType, Outcome, jwk_bytes, jwk_text};
use super::random::bytes;
use super::secret::{Exported, Format};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Curve {
    Ed25519,
    X25519,
}

impl Curve {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "Ed25519" => Some(Self::Ed25519),
            "X25519" => Some(Self::X25519),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Ed25519 => "Ed25519",
            Self::X25519 => "X25519",
        }
    }

    /// id-Ed25519 or id-X25519 (RFC 8410), the last arc of 1.3.101.
    fn arc(self) -> u8 {
        match self {
            Self::Ed25519 => 112,
            Self::X25519 => 110,
        }
    }

    fn oid(self) -> ObjectIdentifier {
        match self {
            Self::Ed25519 => ObjectIdentifier::new_unwrap("1.3.101.112"),
            Self::X25519 => ObjectIdentifier::new_unwrap("1.3.101.110"),
        }
    }

    fn public_of(self, private: &[u8; 32]) -> [u8; 32] {
        match self {
            Self::Ed25519 => SigningKey::from_bytes(private).verifying_key().to_bytes(),
            Self::X25519 => X25519Public::from(&StaticSecret::from(*private)).to_bytes(),
        }
    }

    /// SubjectPublicKeyInfo DER, as RFC 8410 section 4 encodes it.
    fn spki(self, public: &[u8; 32]) -> Key {
        let mut der = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, self.arc()];
        der.extend_from_slice(&[0x03, 0x21, 0x00]);
        der.extend_from_slice(public);
        Key::public(der)
    }

    /// PKCS #8 DER (version 1, no public key), as RFC 8410 section 7 shows.
    fn pkcs8(self, private: &[u8; 32]) -> Key {
        let mut der = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        ];
        der.push(self.arc());
        der.extend_from_slice(&[0x04, 0x22, 0x04, 0x20]);
        der.extend_from_slice(private);
        Key::private(der)
    }

    fn read_spki(self, der: &[u8]) -> Outcome<[u8; 32]> {
        let info = SubjectPublicKeyInfoRef::from_der(der)
            .map_err(|_| Failure::data("not a SubjectPublicKeyInfo"))?;
        if info.algorithm.oid != self.oid() || info.algorithm.parameters.is_some() {
            return Err(Failure::data(format!("not an {} public key", self.name())));
        }
        info.subject_public_key
            .as_bytes()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| Failure::data("the public key is not 32 bytes"))
    }

    fn read_pkcs8(self, der: &[u8]) -> Outcome<[u8; 32]> {
        let info = PrivateKeyInfoRef::from_der(der)
            .map_err(|_| Failure::data("not a PKCS #8 private key"))?;
        if info.algorithm.oid != self.oid() || info.algorithm.parameters.is_some() {
            return Err(Failure::data(format!("not an {} private key", self.name())));
        }
        let inner = OctetString::from_der(info.private_key.as_bytes())
            .map_err(|_| Failure::data("the private key is not an OCTET STRING"))?;
        inner
            .as_bytes()
            .try_into()
            .map_err(|_| Failure::data("the private key is not 32 bytes"))
    }

    fn public(self, key: &Key) -> Outcome<[u8; 32]> {
        match key.kind {
            KeyType::Public => self
                .read_spki(&key.data)
                .map_err(|_| Failure::operation("invalid public key")),
            _ => Err(Failure::invalid_access("the key is not a public key")),
        }
    }

    fn private(self, key: &Key) -> Outcome<[u8; 32]> {
        match key.kind {
            KeyType::Private => self
                .read_pkcs8(&key.data)
                .map_err(|_| Failure::operation("invalid private key")),
            _ => Err(Failure::invalid_access("the key is not a private key")),
        }
    }
}

pub(super) fn generate(curve: Curve) -> Outcome<(Key, Key, Value)> {
    let private = bytes::<32>()?;
    Ok((
        curve.spki(&curve.public_of(&private)),
        curve.pkcs8(&private),
        json!({}),
    ))
}

pub(super) fn import(
    curve: Curve,
    format: Format,
    data: Vec<u8>,
    jwk: Option<&Value>,
) -> Outcome<(Key, Value)> {
    let key = match (format, jwk) {
        (Format::Raw, _) => {
            let public: [u8; 32] = data
                .try_into()
                .map_err(|_| Failure::data("the public key is not 32 bytes"))?;
            curve.spki(&public)
        }
        (Format::Spki, _) => curve.spki(&curve.read_spki(&data)?),
        (Format::Pkcs8, _) => curve.pkcs8(&curve.read_pkcs8(&data)?),
        (Format::Jwk, Some(jwk)) => {
            if jwk.get("kty").and_then(Value::as_str) != Some("OKP") {
                return Err(Failure::data("the JWK kty is not OKP"));
            }
            if jwk.get("crv").and_then(Value::as_str) != Some(curve.name()) {
                return Err(Failure::data("the JWK crv does not match the algorithm"));
            }
            let public: [u8; 32] = jwk_bytes(jwk, "x")?
                .try_into()
                .map_err(|_| Failure::data("the JWK x is not 32 bytes"))?;
            if jwk.get("d").is_none() {
                curve.spki(&public)
            } else {
                let private: [u8; 32] = jwk_bytes(jwk, "d")?
                    .try_into()
                    .map_err(|_| Failure::data("the JWK d is not 32 bytes"))?;
                if curve.public_of(&private) != public {
                    return Err(Failure::data("the JWK d does not match x"));
                }
                curve.pkcs8(&private)
            }
        }
        _ => return Err(Failure::not_supported("unsupported key format")),
    };
    Ok((key, json!({})))
}

pub(super) fn export(curve: Curve, format: Format, key: &Key) -> Outcome<Exported> {
    match (format, key.kind) {
        (Format::Spki, KeyType::Public) | (Format::Pkcs8, KeyType::Private) => {
            Ok(Exported::Raw(key.data.to_vec()))
        }
        (Format::Raw, KeyType::Public) => Ok(Exported::Raw(curve.public(key)?.to_vec())),
        (Format::Jwk, KeyType::Public) => Ok(Exported::Jwk(json!({
            "kty": "OKP",
            "crv": curve.name(),
            "x": jwk_text(&curve.public(key)?),
        }))),
        (Format::Jwk, KeyType::Private) => {
            let private = curve.private(key)?;
            Ok(Exported::Jwk(json!({
                "kty": "OKP",
                "crv": curve.name(),
                "x": jwk_text(&curve.public_of(&private)),
                "d": jwk_text(&private),
            })))
        }
        _ => Err(Failure::invalid_access(
            "the key cannot be exported in this format",
        )),
    }
}

pub(super) fn sign(key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    let private = Curve::Ed25519.private(key)?;
    use ed25519_dalek::Signer;
    Ok(SigningKey::from_bytes(&private)
        .sign(data)
        .to_bytes()
        .to_vec())
}

/// Strict verification, which rejects small-order keys and signature
/// points and non-canonical encodings.
pub(super) fn verify(key: &Key, data: &[u8], signature: &[u8]) -> Outcome<bool> {
    let public = Curve::Ed25519.public(key)?;
    let Ok(verifier) = VerifyingKey::from_bytes(&public) else {
        return Ok(false);
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return Ok(false);
    };
    Ok(verifier.verify_strict(data, &signature).is_ok())
}

/// X25519; an all-zero shared secret, from a small-order point, fails.
pub(super) fn derive_bits(key: &Key, public: &Key, length: Option<u32>) -> Outcome<Vec<u8>> {
    let private = Curve::X25519.private(key)?;
    let public = Curve::X25519.public(public)?;
    let shared = StaticSecret::from(private).diffie_hellman(&X25519Public::from(public));
    if !shared.was_contributory() {
        return Err(Failure::operation("the shared secret is all zero"));
    }
    truncate(shared.as_bytes().to_vec(), length)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_through_every_format() {
        for curve in [Curve::Ed25519, Curve::X25519] {
            let (public, private, _) = generate(curve).unwrap();
            for (format, key) in [
                (Format::Spki, &public),
                (Format::Pkcs8, &private),
                (Format::Raw, &public),
                (Format::Jwk, &private),
                (Format::Jwk, &public),
            ] {
                let (data, jwk) = match export(curve, format, key).unwrap() {
                    Exported::Raw(data) => (data, None),
                    Exported::Jwk(jwk) => (Vec::new(), Some(jwk)),
                };
                let (imported, _) = import(curve, format, data, jwk.as_ref()).unwrap();
                assert_eq!(imported.data, key.data);
            }
        }
    }

    #[test]
    fn signs_verifies_and_agrees() {
        let (public, private, _) = generate(Curve::Ed25519).unwrap();
        let signature = sign(&private, b"data").unwrap();
        assert!(verify(&public, b"data", &signature).unwrap());
        assert!(!verify(&public, b"other", &signature).unwrap());
        assert!(!verify(&public, b"data", &signature[..63]).unwrap());

        let (a_public, a_private, _) = generate(Curve::X25519).unwrap();
        let (b_public, b_private, _) = generate(Curve::X25519).unwrap();
        assert_eq!(
            derive_bits(&a_private, &b_public, None).unwrap(),
            derive_bits(&b_private, &a_public, None).unwrap()
        );
        let zero = Curve::X25519.spki(&[0; 32]);
        assert_eq!(
            derive_bits(&a_private, &zero, None).unwrap_err().name,
            "OperationError"
        );
    }
}

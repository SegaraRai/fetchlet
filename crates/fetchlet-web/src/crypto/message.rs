//! Messages of the `crypto.*` operations.
//!
//! The guest normalizes algorithms and checks key usages as the Web
//! Cryptography API specifies; the host receives normalized parameters and
//! key material and does the cryptography. Bytes travel as base64 strings
//! so that keys created while a module evaluates, outside any invocation,
//! work like the others.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde::de::{Deserializer, Error as _};
use serde::{Deserialize, Serialize, Serializer};

/// Bytes, as standard base64 in messages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Bytes(pub Vec<u8>);

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <&str>::deserialize(deserializer)?;
        STANDARD
            .decode(text)
            .map(Bytes)
            .map_err(|_| D::Error::custom("invalid base64"))
    }
}

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl std::ops::Deref for Bytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.0
    }
}

/// A normalized algorithm: the dictionary members the guest converted,
/// with hash identifiers reduced to their names.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct Algorithm {
    pub name: String,
    pub hash: Option<String>,
    pub named_curve: Option<String>,
    pub length: Option<u32>,
    pub modulus_length: Option<u32>,
    pub public_exponent: Option<Bytes>,
    pub salt_length: Option<u32>,
    pub label: Option<Bytes>,
    pub iv: Option<Bytes>,
    pub counter: Option<Bytes>,
    pub additional_data: Option<Bytes>,
    pub tag_length: Option<u32>,
    pub salt: Option<Bytes>,
    pub info: Option<Bytes>,
    pub iterations: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum KeyType {
    Secret,
    Public,
    Private,
}

/// Key material as the guest's CryptoKey holds it: raw bytes for secret
/// keys, SubjectPublicKeyInfo DER for public keys and PKCS #8 DER for
/// private keys.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Key {
    #[serde(rename = "type")]
    pub kind: KeyType,
    pub data: Bytes,
}

impl Key {
    pub fn secret(data: Vec<u8>) -> Self {
        Self {
            kind: KeyType::Secret,
            data: Bytes(data),
        }
    }

    pub fn public(data: Vec<u8>) -> Self {
        Self {
            kind: KeyType::Public,
            data: Bytes(data),
        }
    }

    pub fn private(data: Vec<u8>) -> Self {
        Self {
            kind: KeyType::Private,
            data: Bytes(data),
        }
    }
}

/// A Web Cryptography API exception, which the guest throws as a
/// DOMException with this name.
#[derive(Debug)]
pub(super) struct Failure {
    pub name: &'static str,
    pub message: String,
}

impl Failure {
    pub fn data(message: impl Into<String>) -> Self {
        Self {
            name: "DataError",
            message: message.into(),
        }
    }

    pub fn operation(message: impl Into<String>) -> Self {
        Self {
            name: "OperationError",
            message: message.into(),
        }
    }

    pub fn not_supported(message: impl Into<String>) -> Self {
        Self {
            name: "NotSupportedError",
            message: message.into(),
        }
    }

    pub fn invalid_access(message: impl Into<String>) -> Self {
        Self {
            name: "InvalidAccessError",
            message: message.into(),
        }
    }
}

pub(super) type Outcome<T> = Result<T, Failure>;

/// Decode a base64url JWK member (RFC 7518 without padding).
pub(super) fn jwk_bytes(jwk: &serde_json::Value, member: &str) -> Outcome<Vec<u8>> {
    let text = jwk
        .get(member)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| Failure::data(format!("the JWK has no {member} member")))?;
    URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| Failure::data(format!("the JWK {member} member is not base64url")))
}

/// Encode bytes as a base64url JWK member.
pub(super) fn jwk_text(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

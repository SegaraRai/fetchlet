//! Key formats, and the JSON Web Key form of secret keys (`kty` "oct").

use serde_json::{Value, json};

use super::message::{Failure, Outcome, jwk_bytes, jwk_text};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Format {
    Raw,
    Spki,
    Pkcs8,
    Jwk,
}

impl Format {
    pub fn parse(name: &str) -> Outcome<Self> {
        match name {
            "raw" => Ok(Self::Raw),
            "spki" => Ok(Self::Spki),
            "pkcs8" => Ok(Self::Pkcs8),
            "jwk" => Ok(Self::Jwk),
            _ => Err(Failure::not_supported(format!(
                "unsupported key format {name}"
            ))),
        }
    }
}

/// An exported key: bytes, or the key members of a JSON Web Key, to which
/// the guest adds `alg`, `key_ops` and `ext`.
pub(super) enum Exported {
    Raw(Vec<u8>),
    Jwk(Value),
}

pub(super) fn read_oct_jwk(jwk: &Value) -> Outcome<Vec<u8>> {
    if jwk.get("kty").and_then(Value::as_str) != Some("oct") {
        return Err(Failure::data("the JWK kty is not oct"));
    }
    jwk_bytes(jwk, "k")
}

pub(super) fn oct_jwk(data: &[u8]) -> Value {
    json!({ "kty": "oct", "k": jwk_text(data) })
}

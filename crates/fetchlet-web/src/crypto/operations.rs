//! The `crypto.*` operations: request parsing, caller budgets and routing
//! by algorithm name.
//!
//! A request that does not parse is a host error. A request that the Web
//! Cryptography API rejects replies `{"error": {"name", "message"}}`, which
//! the guest throws as a DOMException; a successful one replies
//! `{"value": ...}`.

use serde::Deserialize;
use serde_json::{Value, json};

use super::digest::{Hash, digest};
use super::message::{Algorithm, Bytes, Failure, Key, Outcome};
use super::okp::Curve;
use super::random::fill;
use super::secret::{Exported, Format};
use super::{aes, ec, hmac, kdf, okp, rsa};
use crate::limits::check_limit;
use crate::{Error, Result, WebLimits};

/// The `getRandomValues` quota of the Web Cryptography API, in bytes.
const RANDOM_QUOTA: usize = 65_536;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    algorithm: Algorithm,
    /// The algorithm of `key`, as its CryptoKey reports it.
    key_algorithm: Option<Algorithm>,
    key: Option<Key>,
    /// The peer's public key of ECDH and X25519.
    public: Option<Key>,
    format: Option<String>,
    data: Option<Bytes>,
    jwk: Option<Value>,
    signature: Option<Bytes>,
    length: Option<u32>,
}

impl Request {
    fn key(&self) -> Result<&Key> {
        self.key
            .as_ref()
            .ok_or_else(|| Error::InvalidRequest("the request has no key".into()))
    }

    fn key_algorithm(&self) -> Result<&Algorithm> {
        self.key_algorithm
            .as_ref()
            .ok_or_else(|| Error::InvalidRequest("the request has no key algorithm".into()))
    }

    fn data(&self) -> &[u8] {
        self.data.as_deref().unwrap_or_default()
    }
}

pub(crate) fn dispatch(operation: &str, input: &str, limits: &WebLimits) -> Result<Value> {
    if operation == "crypto.random" {
        return random(input);
    }
    let request: Request = serde_json::from_str(input)
        .map_err(|error| Error::InvalidRequest(format!("invalid crypto request: {error}")))?;
    let outcome = match operation {
        "crypto.digest" => {
            check_limit(limits.digest_bytes, request.data().len(), "digest bytes")?;
            Hash::parse(Some(&request.algorithm.name))
                .map(|hash| json!(Bytes(digest(hash, request.data()))))
        }
        "crypto.generateKey" => {
            check_budgets(&request.algorithm, limits)?;
            generate(&request.algorithm)
        }
        "crypto.importKey" => import(&request),
        "crypto.exportKey" => export(&request)?,
        "crypto.sign" => sign(&request)?.map(|bytes| json!(Bytes(bytes))),
        "crypto.verify" => verify(&request)?.map(|verified| json!(verified)),
        "crypto.encrypt" => encrypt(&request, true)?.map(|bytes| json!(Bytes(bytes))),
        "crypto.decrypt" => encrypt(&request, false)?.map(|bytes| json!(Bytes(bytes))),
        "crypto.deriveBits" => {
            check_budgets(&request.algorithm, limits)?;
            derive_bits(&request)?.map(|bytes| json!(Bytes(bytes)))
        }
        _ => return Err(Error::UnknownOperation),
    };
    Ok(match outcome {
        Ok(value) => json!({ "value": value }),
        Err(failure) => json!({ "error": { "name": failure.name, "message": failure.message } }),
    })
}

/// `getRandomValues`: the guest checks the quota and throws
/// QuotaExceededError; the host enforces it too.
fn random(input: &str) -> Result<Value> {
    let size: usize = serde_json::from_str(input)
        .map_err(|_| Error::InvalidRequest("invalid random length".into()))?;
    if size > RANDOM_QUOTA {
        return Err(Error::LimitExceeded("random bytes"));
    }
    let mut bytes = vec![0; size];
    fill(&mut bytes).map_err(|_| Error::Unavailable("random source"))?;
    Ok(json!(Bytes(bytes)))
}

/// The caller's budgets for work that grows with a parameter: RSA key
/// generation with the modulus length and PBKDF2 with its iterations.
fn check_budgets(algorithm: &Algorithm, limits: &WebLimits) -> Result<()> {
    if let Some(bits) = algorithm.modulus_length {
        check_limit(limits.rsa_modulus_bits, bits as usize, "RSA modulus bits")?;
    }
    if algorithm.name == "PBKDF2" {
        let iterations = algorithm.iterations.unwrap_or(0);
        check_limit(
            limits.pbkdf2_iterations,
            iterations as usize,
            "PBKDF2 iterations",
        )?;
    }
    Ok(())
}

fn unsupported<T>(name: &str) -> Outcome<T> {
    Err(Failure::not_supported(format!("{name} is not supported")))
}

fn is_rsa(name: &str) -> bool {
    matches!(name, "RSASSA-PKCS1-v1_5" | "RSA-PSS" | "RSA-OAEP")
}

fn is_aes(name: &str) -> bool {
    matches!(name, "AES-CTR" | "AES-CBC" | "AES-GCM" | "AES-KW")
}

fn is_ec(name: &str) -> bool {
    matches!(name, "ECDSA" | "ECDH")
}

/// A secret key replies `{key, algorithm}` and a key pair
/// `{publicKey, privateKey, algorithm}`, where `algorithm` holds the members
/// the host determined, such as an HMAC key's length.
fn generate(algorithm: &Algorithm) -> Outcome<Value> {
    let name = algorithm.name.as_str();
    let pair = |(public, private, properties): (Key, Key, Value)| json!({ "publicKey": public, "privateKey": private, "algorithm": properties });
    let single = |(key, properties): (Key, Value)| json!({ "key": key, "algorithm": properties });
    match name {
        "HMAC" => hmac::generate(algorithm).map(single),
        name if is_aes(name) => aes::generate(algorithm).map(single),
        name if is_rsa(name) => rsa::generate(algorithm).map(pair),
        name if is_ec(name) => ec::generate(algorithm).map(pair),
        name => match Curve::parse(name) {
            Some(curve) => okp::generate(curve).map(pair),
            None => unsupported(name),
        },
    }
}

fn import(request: &Request) -> Outcome<Value> {
    let algorithm = &request.algorithm;
    let format = Format::parse(request.format.as_deref().unwrap_or_default())?;
    let data = request.data().to_vec();
    let jwk = request.jwk.as_ref();
    if format == Format::Jwk && jwk.is_none() {
        return Err(Failure::data("the key data is not a JSON Web Key"));
    }
    let name = algorithm.name.as_str();
    let (key, properties) = match name {
        "HMAC" => hmac::import(algorithm, format, data, jwk),
        "HKDF" | "PBKDF2" => kdf::import(format, data),
        name if is_aes(name) => aes::import(format, data, jwk),
        name if is_rsa(name) => rsa::import(algorithm, format, data, jwk),
        name if is_ec(name) => ec::import(algorithm, format, data, jwk),
        name => match Curve::parse(name) {
            Some(curve) => okp::import(curve, format, data, jwk),
            None => unsupported(name),
        },
    }?;
    Ok(json!({ "key": key, "algorithm": properties }))
}

/// Replies the key bytes as base64, or a JSON Web Key object.
fn export(request: &Request) -> Result<Outcome<Value>> {
    let key = request.key()?;
    let key_algorithm = request.key_algorithm()?;
    let exported =
        Format::parse(request.format.as_deref().unwrap_or_default()).and_then(|format| {
            let name = key_algorithm.name.as_str();
            match name {
                "HMAC" => hmac::export(format, key),
                "HKDF" | "PBKDF2" => Err(Failure::not_supported("derivation keys do not export")),
                name if is_aes(name) => aes::export(format, key),
                name if is_rsa(name) => rsa::export(format, key),
                name if is_ec(name) => ec::export(key_algorithm, format, key),
                name => match Curve::parse(name) {
                    Some(curve) => okp::export(curve, format, key),
                    None => unsupported(name),
                },
            }
        });
    Ok(exported.map(|exported| match exported {
        Exported::Raw(bytes) => json!(Bytes(bytes)),
        Exported::Jwk(jwk) => jwk,
    }))
}

fn sign(request: &Request) -> Result<Outcome<Vec<u8>>> {
    let key = request.key()?;
    let key_algorithm = request.key_algorithm()?;
    let algorithm = &request.algorithm;
    let data = request.data();
    Ok(match algorithm.name.as_str() {
        "HMAC" => hmac::sign(key_algorithm, key, data),
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" => rsa::sign(algorithm, key_algorithm, key, data),
        "ECDSA" => ec::sign(algorithm, key_algorithm, key, data),
        "Ed25519" => okp::sign(key, data),
        name => unsupported(name),
    })
}

fn verify(request: &Request) -> Result<Outcome<bool>> {
    let key = request.key()?;
    let key_algorithm = request.key_algorithm()?;
    let algorithm = &request.algorithm;
    let data = request.data();
    let signature = request.signature.as_deref().unwrap_or_default();
    Ok(match algorithm.name.as_str() {
        "HMAC" => hmac::verify(key_algorithm, key, data, signature),
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" => {
            rsa::verify(algorithm, key_algorithm, key, data, signature)
        }
        "ECDSA" => ec::verify(algorithm, key_algorithm, key, data, signature),
        "Ed25519" => okp::verify(key, data, signature),
        name => unsupported(name),
    })
}

fn encrypt(request: &Request, encrypt: bool) -> Result<Outcome<Vec<u8>>> {
    let key = request.key()?;
    let key_algorithm = request.key_algorithm()?;
    let algorithm = &request.algorithm;
    let data = request.data();
    Ok(match algorithm.name.as_str() {
        "RSA-OAEP" if encrypt => rsa::encrypt(algorithm, key_algorithm, key, data),
        "RSA-OAEP" => rsa::decrypt(algorithm, key_algorithm, key, data),
        name if is_aes(name) && encrypt => aes::encrypt(algorithm, key, data),
        name if is_aes(name) => aes::decrypt(algorithm, key, data),
        name => unsupported(name),
    })
}

fn derive_bits(request: &Request) -> Result<Outcome<Vec<u8>>> {
    let key = request.key()?;
    let key_algorithm = request.key_algorithm()?;
    let algorithm = &request.algorithm;
    let public = || {
        request
            .public
            .as_ref()
            .ok_or_else(|| Error::InvalidRequest("the request has no public key".into()))
    };
    Ok(match algorithm.name.as_str() {
        "HKDF" | "PBKDF2" => kdf::derive_bits(algorithm, key, request.length),
        "ECDH" => ec::derive_bits(key_algorithm, key, public()?, request.length),
        "X25519" => okp::derive_bits(key, public()?, request.length),
        name => unsupported(name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(operation: &str, request: Value) -> Value {
        call_with(operation, request, &WebLimits::default())
    }

    fn call_with(operation: &str, request: Value, limits: &WebLimits) -> Value {
        let reply = dispatch(operation, &request.to_string(), limits).unwrap();
        reply
            .get("value")
            .cloned()
            .unwrap_or_else(|| panic!("{operation} failed: {reply}"))
    }

    fn failure(operation: &str, request: Value) -> String {
        let reply = dispatch(operation, &request.to_string(), &WebLimits::default()).unwrap();
        reply["error"]["name"].as_str().unwrap().to_owned()
    }

    #[test]
    fn random_and_digest_follow_the_quota_and_budget() {
        let reply = random("16").unwrap();
        assert_eq!(reply.as_str().unwrap().len(), 24);
        assert!(matches!(random("65537"), Err(Error::LimitExceeded(_))));
        let digest = call(
            "crypto.digest",
            json!({ "algorithm": { "name": "SHA-256" }, "data": "YWJj" }),
        );
        assert_eq!(digest, "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
        let limits = WebLimits {
            digest_bytes: Some(2),
            ..WebLimits::default()
        };
        let request = json!({ "algorithm": { "name": "SHA-256" }, "data": "YWJj" }).to_string();
        assert!(matches!(
            dispatch("crypto.digest", &request, &limits),
            Err(Error::LimitExceeded("digest bytes"))
        ));
        assert_eq!(
            failure("crypto.digest", json!({ "algorithm": { "name": "MD5" } })),
            "NotSupportedError"
        );
    }

    #[test]
    fn a_generated_hmac_key_signs_and_verifies() {
        let algorithm = json!({ "name": "HMAC", "hash": "SHA-256" });
        let generated = call("crypto.generateKey", json!({ "algorithm": algorithm }));
        assert_eq!(generated["algorithm"]["length"], 512);
        let key = &generated["key"];
        let signature = call(
            "crypto.sign",
            json!({ "algorithm": algorithm, "keyAlgorithm": algorithm, "key": key, "data": "YWJj" }),
        );
        let request = |data: &str| {
            json!({
                "algorithm": algorithm, "keyAlgorithm": algorithm, "key": key,
                "data": data, "signature": signature,
            })
        };
        assert_eq!(call("crypto.verify", request("YWJj")), true);
        assert_eq!(call("crypto.verify", request("YWJk")), false);
    }

    #[test]
    fn rsa_keys_generate_within_the_budget_and_encrypt() {
        let algorithm = json!({
            "name": "RSA-OAEP", "hash": "SHA-256", "modulusLength": 1024, "publicExponent": "AQAB",
        });
        let limits = WebLimits {
            rsa_modulus_bits: Some(512),
            ..WebLimits::default()
        };
        let request = json!({ "algorithm": algorithm }).to_string();
        assert!(matches!(
            dispatch("crypto.generateKey", &request, &limits),
            Err(Error::LimitExceeded("RSA modulus bits"))
        ));
        // Exponents 1 and 65536, which no prime pair satisfies.
        for exponent in ["AQ==", "AQAA"] {
            let mut algorithm = algorithm.clone();
            algorithm["publicExponent"] = json!(exponent);
            let request = json!({ "algorithm": algorithm });
            assert_eq!(failure("crypto.generateKey", request), "OperationError");
        }
        let pair = call("crypto.generateKey", json!({ "algorithm": algorithm }));
        assert_eq!(pair["algorithm"]["modulusLength"], 1024);
        assert_eq!(pair["algorithm"]["publicExponent"], "AQAB");
        let encrypted = call(
            "crypto.encrypt",
            json!({
                "algorithm": { "name": "RSA-OAEP", "label": "bGFiZWw=" },
                "keyAlgorithm": algorithm, "key": pair["publicKey"], "data": "c2VjcmV0",
            }),
        );
        let decrypt = |label: &str| {
            json!({
                "algorithm": { "name": "RSA-OAEP", "label": label },
                "keyAlgorithm": algorithm, "key": pair["privateKey"], "data": encrypted,
            })
        };
        assert_eq!(call("crypto.decrypt", decrypt("bGFiZWw=")), "c2VjcmV0");
        assert_eq!(failure("crypto.decrypt", decrypt("")), "OperationError");

        for name in ["RSASSA-PKCS1-v1_5", "RSA-PSS"] {
            let key_algorithm = json!({
                "name": name, "hash": "SHA-1", "modulusLength": 1024, "publicExponent": "AQAB",
            });
            let algorithm = json!({ "name": name, "saltLength": 20 });
            let pair = call("crypto.generateKey", json!({ "algorithm": key_algorithm }));
            let jwk = call(
                "crypto.exportKey",
                json!({ "format": "jwk", "keyAlgorithm": key_algorithm, "key": pair["privateKey"], "algorithm": key_algorithm }),
            );
            let imported = call(
                "crypto.importKey",
                json!({ "format": "jwk", "algorithm": key_algorithm, "jwk": jwk }),
            );
            assert_eq!(imported["key"], pair["privateKey"]);
            let signature = call(
                "crypto.sign",
                json!({ "algorithm": algorithm, "keyAlgorithm": key_algorithm, "key": pair["privateKey"], "data": "YWJj" }),
            );
            let verified = call(
                "crypto.verify",
                json!({
                    "algorithm": algorithm, "keyAlgorithm": key_algorithm, "key": pair["publicKey"],
                    "data": "YWJj", "signature": signature,
                }),
            );
            assert_eq!(verified, true, "{name}");
        }
    }

    #[test]
    fn pbkdf2_iterations_stay_within_the_budget() {
        let key = call(
            "crypto.importKey",
            json!({ "format": "raw", "algorithm": { "name": "PBKDF2" }, "data": "cGFzc3dvcmQ=" }),
        )["key"]
            .clone();
        let request = |iterations: u32| {
            json!({
                "algorithm": { "name": "PBKDF2", "hash": "SHA-256", "salt": "c2FsdA==", "iterations": iterations },
                "keyAlgorithm": { "name": "PBKDF2" }, "key": key, "length": 256,
            })
        };
        let limits = WebLimits {
            pbkdf2_iterations: Some(1000),
            ..WebLimits::default()
        };
        assert!(call_with("crypto.deriveBits", request(1000), &limits).is_string());
        assert!(matches!(
            dispatch("crypto.deriveBits", &request(1001).to_string(), &limits),
            Err(Error::LimitExceeded("PBKDF2 iterations"))
        ));
    }

    #[test]
    fn key_agreement_uses_the_peer_public_key() {
        for algorithm in [
            json!({ "name": "ECDH", "namedCurve": "P-384" }),
            json!({ "name": "X25519" }),
        ] {
            let a = call("crypto.generateKey", json!({ "algorithm": algorithm }));
            let b = call("crypto.generateKey", json!({ "algorithm": algorithm }));
            let derive = |own: &Value, peer: &Value| {
                call(
                    "crypto.deriveBits",
                    json!({
                        "algorithm": algorithm, "keyAlgorithm": algorithm,
                        "key": own["privateKey"], "public": peer["publicKey"], "length": 128,
                    }),
                )
            };
            assert_eq!(derive(&a, &b), derive(&b, &a));
        }
    }

    #[test]
    fn malformed_requests_are_host_errors_and_spec_errors_are_replies() {
        assert!(matches!(
            dispatch("crypto.sign", "{}", &WebLimits::default()),
            Err(Error::InvalidRequest(_))
        ));
        assert_eq!(
            failure(
                "crypto.importKey",
                json!({ "format": "raw", "algorithm": { "name": "AES-GCM" }, "data": "AAAA" }),
            ),
            "DataError"
        );
        assert_eq!(
            failure(
                "crypto.generateKey",
                json!({ "algorithm": { "name": "AES-GCM", "length": 100 } })
            ),
            "OperationError"
        );
    }
}

//! RSA keys and the RSASSA-PKCS1-v1_5, RSA-PSS and RSA-OAEP schemes of
//! RFC 8017.

use getrandom::SysRng;
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::{BoxedUint, Oaep, Pkcs1v15Sign, PrivateKey, Pss, PublicKey};
use serde_json::{Value, json};

use super::digest::{Hash, digest, with_hash};
use super::message::{Algorithm, Bytes, Failure, Key, KeyType, Outcome, jwk_bytes, jwk_text};
use super::secret::{Exported, Format};

/// The modulus length and public exponent that the key's algorithm reports.
fn properties(key: &impl PublicKeyParts) -> Value {
    json!({
        "modulusLength": key.n().bit_width(),
        "publicExponent": Bytes(key.e().to_be_bytes_trimmed_vartime().to_vec()),
    })
}

fn integer(bytes: &[u8]) -> BoxedUint {
    BoxedUint::from_be_slice_vartime(bytes)
}

/// A key pair of `modulusLength` bits.
pub(super) fn generate(algorithm: &Algorithm) -> Outcome<(Key, Key, Value)> {
    Hash::parse(algorithm.hash.as_deref())?;
    let bits = algorithm.modulus_length.unwrap_or(0);
    let exponent = algorithm.public_exponent.as_deref().unwrap_or_default();
    // Prime generation never ends for an even exponent or one below 3, so
    // only odd exponents from 3 to 2^32 - 1 generate keys.
    let exponent = match trimmed(exponent) {
        bytes if bytes.len() <= 4 => bytes
            .iter()
            .fold(0u32, |value, &byte| (value << 8) | u32::from(byte)),
        _ => 0,
    };
    if exponent < 3 || exponent.is_multiple_of(2) {
        return Err(Failure::operation("unsupported RSA public exponent"));
    }
    let exponent = BoxedUint::from(exponent);
    let private = PrivateKey::new_with_exp(&mut SysRng, bits as usize, exponent)
        .map_err(|error| Failure::operation(format!("RSA key generation failed: {error}")))?;
    let public = private.to_public_key();
    Ok((
        public_key(&public)?,
        private_key(&private)?,
        properties(&public),
    ))
}

fn public_key(key: &PublicKey) -> Outcome<Key> {
    let der = key
        .to_public_key_der()
        .map_err(|_| Failure::operation("the public key cannot be encoded"))?;
    Ok(Key::public(der.as_bytes().to_vec()))
}

fn private_key(key: &PrivateKey) -> Outcome<Key> {
    let der = key
        .to_pkcs8_der()
        .map_err(|_| Failure::operation("the private key cannot be encoded"))?;
    Ok(Key::private(der.as_bytes().to_vec()))
}

pub(super) fn import(
    algorithm: &Algorithm,
    format: Format,
    data: Vec<u8>,
    jwk: Option<&Value>,
) -> Outcome<(Key, Value)> {
    Hash::parse(algorithm.hash.as_deref())?;
    match (format, jwk) {
        (Format::Spki, _) => {
            let key = PublicKey::from_public_key_der(&data)
                .map_err(|_| Failure::data("not an RSA SubjectPublicKeyInfo"))?;
            Ok((public_key(&key)?, properties(&key)))
        }
        (Format::Pkcs8, _) => {
            let key = PrivateKey::from_pkcs8_der(&data)
                .map_err(|_| Failure::data("not an RSA PKCS #8 private key"))?;
            Ok((private_key(&key)?, properties(&key)))
        }
        (Format::Jwk, Some(jwk)) => import_jwk(jwk),
        _ => Err(Failure::not_supported(
            "RSA keys import as spki, pkcs8 or jwk",
        )),
    }
}

fn import_jwk(jwk: &Value) -> Outcome<(Key, Value)> {
    if jwk.get("kty").and_then(Value::as_str) != Some("RSA") {
        return Err(Failure::data("the JWK kty is not RSA"));
    }
    let n = integer(&jwk_bytes(jwk, "n")?);
    let e = integer(&jwk_bytes(jwk, "e")?);
    if jwk.get("d").is_none() {
        let key = PublicKey::new(n, e).map_err(|_| Failure::data("invalid RSA public key"))?;
        return Ok((public_key(&key)?, properties(&key)));
    }
    if jwk.get("oth").is_some() {
        return Err(Failure::not_supported(
            "multi-prime RSA keys are not supported",
        ));
    }
    let d = integer(&jwk_bytes(jwk, "d")?);
    let p = integer(&jwk_bytes(jwk, "p")?);
    let q = integer(&jwk_bytes(jwk, "q")?);
    for member in ["dp", "dq", "qi"] {
        jwk_bytes(jwk, member)?;
    }
    let key = PrivateKey::from_components(n, e, d, vec![p, q])
        .map_err(|_| Failure::data("invalid RSA private key"))?;
    let consistent = [
        (
            "dp",
            key.dp().map(|value| value.to_be_bytes_trimmed_vartime()),
        ),
        (
            "dq",
            key.dq().map(|value| value.to_be_bytes_trimmed_vartime()),
        ),
        (
            "qi",
            key.crt_coefficient()
                .map(|value| value.to_be_bytes_trimmed_vartime()),
        ),
    ]
    .into_iter()
    .all(|(member, value)| {
        value
            .is_some_and(|value| trimmed(&jwk_bytes(jwk, member).unwrap_or_default()) == &value[..])
    });
    if !consistent {
        return Err(Failure::data("the JWK CRT parameters do not match the key"));
    }
    Ok((private_key(&key)?, properties(&key)))
}

fn trimmed(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|&byte| byte != 0)
        .unwrap_or(bytes.len());
    &bytes[start..]
}

pub(super) fn export(format: Format, key: &Key) -> Outcome<Exported> {
    match (format, key.kind) {
        (Format::Spki, KeyType::Public) | (Format::Pkcs8, KeyType::Private) => {
            Ok(Exported::Raw(key.data.to_vec()))
        }
        (Format::Jwk, KeyType::Public) => {
            let key = decode_public(key)?;
            Ok(Exported::Jwk(json!({
                "kty": "RSA",
                "n": jwk_text(&key.n().to_be_bytes_trimmed_vartime()),
                "e": jwk_text(&key.e().to_be_bytes_trimmed_vartime()),
            })))
        }
        (Format::Jwk, KeyType::Private) => {
            let key = decode_private(key)?;
            let primes = key.primes();
            let part = |value: Option<Box<[u8]>>| {
                value
                    .map(|bytes| jwk_text(&bytes))
                    .ok_or_else(|| Failure::operation("the key has no CRT parameters"))
            };
            Ok(Exported::Jwk(json!({
                "kty": "RSA",
                "n": jwk_text(&key.n().to_be_bytes_trimmed_vartime()),
                "e": jwk_text(&key.e().to_be_bytes_trimmed_vartime()),
                "d": jwk_text(&key.d().to_be_bytes_trimmed_vartime()),
                "p": jwk_text(&primes[0].to_be_bytes_trimmed_vartime()),
                "q": jwk_text(&primes[1].to_be_bytes_trimmed_vartime()),
                "dp": part(key.dp().map(|value| value.to_be_bytes_trimmed_vartime()))?,
                "dq": part(key.dq().map(|value| value.to_be_bytes_trimmed_vartime()))?,
                "qi": part(key.crt_coefficient().map(|value| value.to_be_bytes_trimmed_vartime()))?,
            })))
        }
        (Format::Raw, _) => Err(Failure::not_supported("RSA keys do not export as raw")),
        _ => Err(Failure::invalid_access(
            "the key cannot be exported in this format",
        )),
    }
}

fn decode_public(key: &Key) -> Outcome<PublicKey> {
    match key.kind {
        KeyType::Public => PublicKey::from_public_key_der(&key.data)
            .map_err(|_| Failure::operation("invalid RSA public key")),
        _ => Err(Failure::invalid_access("the key is not an RSA public key")),
    }
}

fn decode_private(key: &Key) -> Outcome<PrivateKey> {
    match key.kind {
        KeyType::Private => PrivateKey::from_pkcs8_der(&key.data)
            .map_err(|_| Failure::operation("invalid RSA private key")),
        _ => Err(Failure::invalid_access("the key is not an RSA private key")),
    }
}

pub(super) fn sign(
    algorithm: &Algorithm,
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let hash = Hash::parse(key_algorithm.hash.as_deref())?;
    let private = decode_private(key)?;
    let hashed = digest(hash, data);
    let signed = match algorithm.name.as_str() {
        "RSASSA-PKCS1-v1_5" => {
            with_hash!(hash, D => private.sign(Pkcs1v15Sign::new::<D>(), &hashed))
        }
        "RSA-PSS" => {
            let salt = algorithm.salt_length.unwrap_or(0) as usize;
            with_hash!(hash, D => private.sign_with_rng(&mut SysRng, Pss::<D>::new_with_salt(salt), &hashed))
        }
        name => return Err(Failure::not_supported(format!("{name} does not sign"))),
    };
    signed.map_err(|error| Failure::operation(format!("RSA signing failed: {error}")))
}

pub(super) fn verify(
    algorithm: &Algorithm,
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
    signature: &[u8],
) -> Outcome<bool> {
    let hash = Hash::parse(key_algorithm.hash.as_deref())?;
    let public = decode_public(key)?;
    let hashed = digest(hash, data);
    let verified = match algorithm.name.as_str() {
        "RSASSA-PKCS1-v1_5" => {
            with_hash!(hash, D => public.verify(Pkcs1v15Sign::new::<D>(), &hashed, signature))
        }
        "RSA-PSS" => {
            let salt = algorithm.salt_length.unwrap_or(0) as usize;
            with_hash!(hash, D => public.verify(Pss::<D>::new_with_salt(salt), &hashed, signature))
        }
        name => return Err(Failure::not_supported(format!("{name} does not verify"))),
    };
    Ok(verified.is_ok())
}

pub(super) fn encrypt(
    algorithm: &Algorithm,
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let hash = Hash::parse(key_algorithm.hash.as_deref())?;
    let public = decode_public(key)?;
    let label = algorithm.label.as_deref().unwrap_or_default().to_vec();
    with_hash!(hash, D => public.encrypt(&mut SysRng, Oaep::<D>::new_with_label(label), data))
        .map_err(|error| Failure::operation(format!("RSA-OAEP encryption failed: {error}")))
}

pub(super) fn decrypt(
    algorithm: &Algorithm,
    key_algorithm: &Algorithm,
    key: &Key,
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let hash = Hash::parse(key_algorithm.hash.as_deref())?;
    let private = decode_private(key)?;
    let label = algorithm.label.as_deref().unwrap_or_default().to_vec();
    with_hash!(hash, D => private.decrypt(Oaep::<D>::new_with_label(label), data))
        .map_err(|_| Failure::operation("RSA-OAEP decryption failed"))
}

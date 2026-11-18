//! The `nodeCrypto.*` operations behind the synchronous hashing and key
//! derivation functions of `node:crypto`: `createHash`, `createHmac`,
//! `pbkdf2Sync`, `hkdfSync` and `scryptSync`, which the guest also uses for
//! their callback forms.
//!
//! Each operation is stateless and takes its whole input in one message.
//! The guest validates arguments as Node does and throws Node's errors, so a
//! request this module rejects is malformed and replies a host error.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::crypto::Bytes;
use crate::limits::check_limit;
use crate::{Error, Result, WebLimits};

/// The hash functions of `crypto.getHashes()` that fetchlet implements.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hash {
    Md5,
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512,
    Sha512_224,
    Sha512_256,
}

impl Hash {
    /// Node's lowercase name of the algorithm; the guest normalizes aliases.
    fn parse(name: &str) -> Result<Self> {
        Ok(match name {
            "md5" => Self::Md5,
            "sha1" => Self::Sha1,
            "sha224" => Self::Sha224,
            "sha256" => Self::Sha256,
            "sha384" => Self::Sha384,
            "sha512" => Self::Sha512,
            "sha512-224" => Self::Sha512_224,
            "sha512-256" => Self::Sha512_256,
            other => {
                return Err(Error::InvalidRequest(format!(
                    "unsupported hash algorithm {other}"
                )));
            }
        })
    }

    /// The output length in bytes, which bounds HKDF's output.
    fn output_bytes(self) -> usize {
        match self {
            Self::Md5 => 16,
            Self::Sha1 => 20,
            Self::Sha224 | Self::Sha512_224 => 28,
            Self::Sha256 | Self::Sha512_256 => 32,
            Self::Sha384 => 48,
            Self::Sha512 => 64,
        }
    }
}

/// Evaluate `$body` with `$digest` bound to the hash function's type.
macro_rules! with_hash {
    ($hash:expr, $digest:ident => $body:expr) => {
        match $hash {
            Hash::Md5 => {
                type $digest = md5::Md5;
                $body
            }
            Hash::Sha1 => {
                type $digest = sha1::Sha1;
                $body
            }
            Hash::Sha224 => {
                type $digest = sha2::Sha224;
                $body
            }
            Hash::Sha256 => {
                type $digest = sha2::Sha256;
                $body
            }
            Hash::Sha384 => {
                type $digest = sha2::Sha384;
                $body
            }
            Hash::Sha512 => {
                type $digest = sha2::Sha512;
                $body
            }
            Hash::Sha512_224 => {
                type $digest = sha2::Sha512_224;
                $body
            }
            Hash::Sha512_256 => {
                type $digest = sha2::Sha512_256;
                $body
            }
        }
    };
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    algorithm: Option<String>,
    data: Option<Bytes>,
    key: Option<Bytes>,
    salt: Option<Bytes>,
    info: Option<Bytes>,
    iterations: Option<u32>,
    length: Option<usize>,
    /// scrypt's cost N, a power of two greater than one.
    cost: Option<u64>,
    block_size: Option<u32>,
    parallelization: Option<u32>,
    /// scrypt's memory bound from the caller's `maxmem` option.
    max_memory: Option<u64>,
}

impl Request {
    fn hash(&self) -> Result<Hash> {
        Hash::parse(self.algorithm.as_deref().unwrap_or_default())
    }

    fn bytes(field: &Option<Bytes>) -> &[u8] {
        field.as_deref().unwrap_or_default()
    }

    fn length(&self) -> Result<usize> {
        self.length
            .ok_or_else(|| Error::InvalidRequest("the request has no length".into()))
    }
}

pub(crate) fn dispatch(operation: &str, input: &str, limits: &WebLimits) -> Result<Value> {
    let request: Request = serde_json::from_str(input)
        .map_err(|error| Error::InvalidRequest(format!("invalid nodeCrypto request: {error}")))?;
    let output = match operation {
        "nodeCrypto.hash" => hash(&request, limits)?,
        "nodeCrypto.hmac" => hmac(&request, limits)?,
        "nodeCrypto.pbkdf2" => pbkdf2(&request, limits)?,
        "nodeCrypto.hkdf" => hkdf(&request)?,
        "nodeCrypto.scrypt" => scrypt(&request, limits)?,
        _ => return Err(Error::UnknownOperation),
    };
    Ok(json!(Bytes(output)))
}

fn hash(request: &Request, limits: &WebLimits) -> Result<Vec<u8>> {
    let data = Request::bytes(&request.data);
    check_limit(limits.digest_bytes, data.len(), "digest bytes")?;
    use sha2::Digest;
    Ok(with_hash!(request.hash()?, D => D::digest(data).to_vec()))
}

fn hmac(request: &Request, limits: &WebLimits) -> Result<Vec<u8>> {
    use hmac::{KeyInit, Mac, SimpleHmac};
    let data = Request::bytes(&request.data);
    check_limit(limits.digest_bytes, data.len(), "digest bytes")?;
    let key = Request::bytes(&request.key);
    // SimpleHmac takes keys of any length, as Node does.
    Ok(with_hash!(request.hash()?, D => {
        let mut mac = <SimpleHmac<D> as KeyInit>::new_from_slice(key)
            .map_err(|_| Error::InvalidRequest("invalid HMAC key".into()))?;
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }))
}

fn pbkdf2(request: &Request, limits: &WebLimits) -> Result<Vec<u8>> {
    let iterations = request.iterations.unwrap_or(0);
    if iterations == 0 {
        return Err(Error::InvalidRequest(
            "PBKDF2 needs at least one iteration".into(),
        ));
    }
    check_limit(
        limits.pbkdf2_iterations,
        iterations as usize,
        "PBKDF2 iterations",
    )?;
    let mut output = vec![0; request.length()?];
    let password = Request::bytes(&request.key);
    let salt = Request::bytes(&request.salt);
    with_hash!(request.hash()?, D => pbkdf2::pbkdf2_hmac::<D>(password, salt, iterations, &mut output));
    Ok(output)
}

fn hkdf(request: &Request) -> Result<Vec<u8>> {
    let hash = request.hash()?;
    let length = request.length()?;
    // RFC 5869: at most 255 blocks of the hash's output.
    if length > 255 * hash.output_bytes() {
        return Err(Error::InvalidRequest("the HKDF output is too long".into()));
    }
    let mut output = vec![0; length];
    let key = Request::bytes(&request.key);
    let salt = Request::bytes(&request.salt);
    let info = Request::bytes(&request.info);
    with_hash!(hash, D => hkdf::SimpleHkdf::<D>::new(Some(salt), key)
        .expand(info, &mut output)
        .map_err(|_| Error::InvalidRequest("the HKDF output is too long".into())))?;
    Ok(output)
}

fn scrypt(request: &Request, limits: &WebLimits) -> Result<Vec<u8>> {
    let cost = request.cost.unwrap_or(0);
    if cost < 2 || !cost.is_power_of_two() {
        return Err(Error::InvalidRequest(
            "the scrypt cost must be a power of two greater than one".into(),
        ));
    }
    let block_size = request.block_size.unwrap_or(0);
    let parallelization = request.parallelization.unwrap_or(0);
    // The working memory is 128 * N * r bytes, as Node counts it for maxmem.
    let memory = 128u128 * u128::from(cost) * u128::from(block_size);
    let memory = usize::try_from(memory).unwrap_or(usize::MAX);
    if request
        .max_memory
        .is_some_and(|max| memory as u128 > u128::from(max))
    {
        return Err(Error::InvalidRequest(
            "the scrypt parameters exceed maxmem".into(),
        ));
    }
    check_limit(limits.scrypt_memory_bytes, memory, "scrypt memory bytes")?;
    let params = scrypt::Params::new(cost.trailing_zeros() as u8, block_size, parallelization)
        .map_err(|_| Error::InvalidRequest("invalid scrypt parameters".into()))?;
    let mut output = vec![0; request.length()?];
    if output.is_empty() {
        return Ok(output);
    }
    scrypt::scrypt(
        Request::bytes(&request.key),
        Request::bytes(&request.salt),
        &params,
        &mut output,
    )
    .map_err(|_| Error::InvalidRequest("invalid scrypt output length".into()))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn run(operation: &str, request: Value) -> Result<String> {
        let value = dispatch(operation, &request.to_string(), &WebLimits::default())?;
        let bytes: Bytes = serde_json::from_str(&value.to_string()).expect("base64 output");
        Ok(hex(&bytes))
    }

    fn base64(bytes: &[u8]) -> String {
        serde_json::to_value(Bytes(bytes.to_vec()))
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn hashes_match_reference_vectors() {
        let abc = base64(b"abc");
        for (algorithm, expected) in [
            ("md5", "900150983cd24fb0d6963f7d28e17f72"),
            ("sha1", "a9993e364706816aba3e25717850c26c9cd0d89d"),
            (
                "sha224",
                "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
            ),
            (
                "sha512-256",
                "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23",
            ),
        ] {
            assert_eq!(
                run(
                    "nodeCrypto.hash",
                    json!({ "algorithm": algorithm, "data": abc })
                )
                .unwrap(),
                expected,
                "{algorithm}"
            );
        }
    }

    #[test]
    fn hmac_accepts_keys_of_any_length() {
        // RFC 4231 test case 6: a 131-byte key, longer than the block.
        let key = base64(&[0xaa; 131]);
        let data = base64(b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(
            run(
                "nodeCrypto.hmac",
                json!({ "algorithm": "sha256", "key": key, "data": data })
            )
            .unwrap(),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
        // RFC 2202 test case 2 for HMAC-MD5.
        assert_eq!(
            run(
                "nodeCrypto.hmac",
                json!({
                    "algorithm": "md5",
                    "key": base64(b"Jefe"),
                    "data": base64(b"what do ya want for nothing?"),
                })
            )
            .unwrap(),
            "750c783e6ab0b503eaa86e310a5db738"
        );
    }

    #[test]
    fn key_derivations_match_reference_vectors() {
        // RFC 6070 test case 2.
        assert_eq!(
            run(
                "nodeCrypto.pbkdf2",
                json!({
                    "algorithm": "sha1",
                    "key": base64(b"password"),
                    "salt": base64(b"salt"),
                    "iterations": 2,
                    "length": 20,
                })
            )
            .unwrap(),
            "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957"
        );
        // RFC 5869 test case 3: no salt and no info.
        assert_eq!(
            run(
                "nodeCrypto.hkdf",
                json!({
                    "algorithm": "sha256",
                    "key": base64(&[0x0b; 22]),
                    "length": 42,
                })
            )
            .unwrap(),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        );
        // RFC 7914 section 12, the second vector.
        assert_eq!(
            run(
                "nodeCrypto.scrypt",
                json!({
                    "key": base64(b"password"),
                    "salt": base64(b"NaCl"),
                    "cost": 1024,
                    "blockSize": 8,
                    "parallelization": 16,
                    "length": 64,
                })
            )
            .unwrap(),
            "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"
        );
    }

    #[test]
    fn budgets_and_maxmem_bound_the_work() {
        let limits = WebLimits {
            pbkdf2_iterations: Some(10),
            scrypt_memory_bytes: Some(1 << 20),
            ..WebLimits::default()
        };
        let pbkdf2 = json!({
            "algorithm": "sha256",
            "key": "",
            "salt": "",
            "iterations": 11,
            "length": 32,
        });
        assert!(matches!(
            dispatch("nodeCrypto.pbkdf2", &pbkdf2.to_string(), &limits),
            Err(Error::LimitExceeded("PBKDF2 iterations"))
        ));
        // 128 * 2^14 * 8 bytes is 16 MiB.
        let scrypt = json!({
            "key": "",
            "salt": "",
            "cost": 16384,
            "blockSize": 8,
            "parallelization": 1,
            "length": 32,
        });
        assert!(matches!(
            dispatch("nodeCrypto.scrypt", &scrypt.to_string(), &limits),
            Err(Error::LimitExceeded("scrypt memory bytes"))
        ));
        let mut capped = scrypt.clone();
        capped["maxMemory"] = json!(1 << 20);
        assert!(matches!(
            dispatch(
                "nodeCrypto.scrypt",
                &capped.to_string(),
                &WebLimits::default()
            ),
            Err(Error::InvalidRequest(_))
        ));
    }
}

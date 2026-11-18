use serde_json::{Value, json};

use crate::limits::check_limit;
use crate::{Error, Result, WebLimits};

// Web Crypto quota: https://www.w3.org/TR/webcrypto-2/#Crypto-method-getRandomValues
const GET_RANDOM_VALUES_QUOTA: usize = 65_536;

pub(crate) fn dispatch(operation: &str, input: &str, limits: &WebLimits) -> Result<Value> {
    match operation {
        "random" => {
            let size: usize = serde_json::from_str(input)
                .map_err(|_| Error::InvalidRequest("invalid random length".into()))?;
            if size > GET_RANDOM_VALUES_QUOTA {
                return Err(Error::LimitExceeded("random bytes"));
            }
            let mut bytes = vec![0u8; size];
            getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable("random source"))?;
            Ok(json!(bytes))
        }
        "sha256" => {
            use sha2::Digest;
            let bytes: Vec<u8> = serde_json::from_str(input)
                .map_err(|_| Error::InvalidRequest("invalid digest bytes".into()))?;
            check_limit(limits.digest_bytes, bytes.len(), "digest bytes")?;
            Ok(json!(sha2::Sha256::digest(&bytes).to_vec()))
        }
        _ => Err(Error::UnknownOperation),
    }
}

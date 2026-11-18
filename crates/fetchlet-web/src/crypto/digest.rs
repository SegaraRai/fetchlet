//! SHA-1 and SHA-2 (FIPS 180-4), the hash functions of the Web Cryptography
//! API, and the generic dispatch over them that other algorithms share.

use super::message::{Failure, Outcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    pub fn parse(name: Option<&str>) -> Outcome<Self> {
        match name {
            Some("SHA-1") => Ok(Self::Sha1),
            Some("SHA-256") => Ok(Self::Sha256),
            Some("SHA-384") => Ok(Self::Sha384),
            Some("SHA-512") => Ok(Self::Sha512),
            Some(other) => Err(Failure::not_supported(format!("unsupported hash {other}"))),
            None => Err(Failure::not_supported("the algorithm has no hash")),
        }
    }

    /// The block size in bits, which is HMAC's default key length.
    pub fn block_bits(self) -> u32 {
        match self {
            Self::Sha1 | Self::Sha256 => 512,
            Self::Sha384 | Self::Sha512 => 1024,
        }
    }
}

/// Evaluate `$body` with `$digest` bound to the hash function's type.
macro_rules! with_hash {
    ($hash:expr, $digest:ident => $body:expr) => {
        match $hash {
            $crate::crypto::digest::Hash::Sha1 => {
                type $digest = sha1::Sha1;
                $body
            }
            $crate::crypto::digest::Hash::Sha256 => {
                type $digest = sha2::Sha256;
                $body
            }
            $crate::crypto::digest::Hash::Sha384 => {
                type $digest = sha2::Sha384;
                $body
            }
            $crate::crypto::digest::Hash::Sha512 => {
                type $digest = sha2::Sha512;
                $body
            }
        }
    };
}
pub(super) use with_hash;

pub(super) fn digest(hash: Hash, data: &[u8]) -> Vec<u8> {
    use sha2::Digest;
    with_hash!(hash, D => D::digest(data).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_match_fips_180_vectors() {
        let hex = |bytes: Vec<u8>| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(
            hex(digest(Hash::Sha1, b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(digest(Hash::Sha256, b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(digest(Hash::Sha384, b"").len(), 48);
        assert_eq!(digest(Hash::Sha512, b"").len(), 64);
        assert!(Hash::parse(Some("MD5")).is_err());
    }
}

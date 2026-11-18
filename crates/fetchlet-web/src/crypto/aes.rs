//! AES keys (FIPS 197) and the AES-CTR, AES-CBC (SP 800-38A), AES-GCM
//! (SP 800-38D) and AES-KW (RFC 3394) operations.

use aes::cipher::array::Array;
use aes::cipher::consts::U16;
use aes::cipher::{BlockCipherDecrypt, BlockCipherEncrypt, KeyInit};
use aes::{Aes128, Aes192, Aes256};
use aes_kw::AesKw;
use ghash::GHash;
use ghash::universal_hash::UniversalHash;
use serde_json::{Value, json};

use super::message::{Algorithm, Failure, Key, Outcome};
use super::random::fill;
use super::secret::{Exported, Format, oct_jwk, read_oct_jwk};

const BLOCK: usize = 16;

pub(super) fn generate(algorithm: &Algorithm) -> Outcome<(Key, Value)> {
    let length = algorithm.length.unwrap_or(0);
    if !matches!(length, 128 | 192 | 256) {
        return Err(Failure::operation("AES keys are 128, 192 or 256 bits"));
    }
    let mut bytes = vec![0; length as usize / 8];
    fill(&mut bytes)?;
    Ok((Key::secret(bytes), json!({ "length": length })))
}

pub(super) fn import(format: Format, data: Vec<u8>, jwk: Option<&Value>) -> Outcome<(Key, Value)> {
    let data = match (format, jwk) {
        (Format::Raw, _) => data,
        (Format::Jwk, Some(jwk)) => read_oct_jwk(jwk)?,
        _ => return Err(Failure::not_supported("AES keys import as raw or jwk")),
    };
    if !matches!(data.len(), 16 | 24 | 32) {
        return Err(Failure::data("AES keys are 128, 192 or 256 bits"));
    }
    let length = data.len() * 8;
    Ok((Key::secret(data), json!({ "length": length })))
}

pub(super) fn export(format: Format, key: &Key) -> Outcome<Exported> {
    match format {
        Format::Raw => Ok(Exported::Raw(key.data.to_vec())),
        Format::Jwk => Ok(Exported::Jwk(oct_jwk(&key.data))),
        _ => Err(Failure::not_supported("AES keys export as raw or jwk")),
    }
}

/// Evaluate `$body` with `$cipher` bound to the AES variant of the key size.
macro_rules! with_cipher {
    ($key:expr, $cipher:ident => $body:expr) => {
        match $key.len() {
            16 => {
                type $cipher = Aes128;
                $body
            }
            24 => {
                type $cipher = Aes192;
                $body
            }
            32 => {
                type $cipher = Aes256;
                $body
            }
            _ => Err(Failure::operation("AES keys are 128, 192 or 256 bits")),
        }
    };
}

pub(super) fn encrypt(algorithm: &Algorithm, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    let key = &key.data[..];
    match algorithm.name.as_str() {
        "AES-CTR" => with_cipher!(key, C => ctr::<C>(algorithm, key, data)),
        "AES-CBC" => with_cipher!(key, C => cbc_encrypt::<C>(algorithm, key, data)),
        "AES-GCM" => with_cipher!(key, C => gcm::<C>(algorithm, key, data, true)),
        "AES-KW" => with_cipher!(key, C => wrap::<C>(key, data)),
        name => Err(Failure::not_supported(format!("{name} does not encrypt"))),
    }
}

pub(super) fn decrypt(algorithm: &Algorithm, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    let key = &key.data[..];
    match algorithm.name.as_str() {
        // CTR mode is its own inverse.
        "AES-CTR" => with_cipher!(key, C => ctr::<C>(algorithm, key, data)),
        "AES-CBC" => with_cipher!(key, C => cbc_decrypt::<C>(algorithm, key, data)),
        "AES-GCM" => with_cipher!(key, C => gcm::<C>(algorithm, key, data, false)),
        "AES-KW" => with_cipher!(key, C => unwrap::<C>(key, data)),
        name => Err(Failure::not_supported(format!("{name} does not decrypt"))),
    }
}

fn cipher<C: KeyInit>(key: &[u8]) -> Outcome<C> {
    C::new_from_slice(key).map_err(|_| Failure::operation("invalid AES key"))
}

/// The rightmost `length` bits of the counter block increment, wrapping
/// within those bits; the rest stays fixed. A message that would reuse a
/// counter value fails.
fn ctr<C: KeyInit + BlockCipherEncrypt<BlockSize = U16>>(
    algorithm: &Algorithm,
    key: &[u8],
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let counter = algorithm.counter.as_deref().unwrap_or_default();
    let counter: [u8; BLOCK] = counter
        .try_into()
        .map_err(|_| Failure::operation("the AES-CTR counter is not 16 bytes"))?;
    let length = algorithm.length.unwrap_or(0);
    if length == 0 || length > 128 {
        return Err(Failure::operation(
            "the AES-CTR length is not 1 to 128 bits",
        ));
    }
    let blocks = data.len().div_ceil(BLOCK) as u128;
    if length < 128 && blocks > 1u128 << length {
        return Err(Failure::operation(
            "the message would reuse a counter value",
        ));
    }
    let cipher: C = cipher(key)?;
    let mask = if length == 128 {
        u128::MAX
    } else {
        (1u128 << length) - 1
    };
    let initial = u128::from_be_bytes(counter);
    let mut output = Vec::with_capacity(data.len());
    for (index, chunk) in data.chunks(BLOCK).enumerate() {
        let low = (initial & mask).wrapping_add(index as u128) & mask;
        let value = (initial & !mask) | low;
        let mut block = Array::from(value.to_be_bytes());
        cipher.encrypt_block(&mut block);
        output.extend(chunk.iter().zip(block.iter()).map(|(a, b)| a ^ b));
    }
    Ok(output)
}

fn iv(algorithm: &Algorithm) -> Outcome<[u8; BLOCK]> {
    algorithm
        .iv
        .as_deref()
        .unwrap_or_default()
        .try_into()
        .map_err(|_| Failure::operation("the AES-CBC iv is not 16 bytes"))
}

/// CBC with PKCS #7 padding.
fn cbc_encrypt<C: KeyInit + BlockCipherEncrypt<BlockSize = U16>>(
    algorithm: &Algorithm,
    key: &[u8],
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let mut previous = iv(algorithm)?;
    let cipher: C = cipher(key)?;
    let padding = BLOCK - data.len() % BLOCK;
    let mut padded = data.to_vec();
    padded.resize(data.len() + padding, padding as u8);
    let mut output = Vec::with_capacity(padded.len());
    for chunk in padded.chunks(BLOCK) {
        let mut block = Array::<u8, U16>::default();
        for (index, byte) in block.iter_mut().enumerate() {
            *byte = chunk[index] ^ previous[index];
        }
        cipher.encrypt_block(&mut block);
        previous.copy_from_slice(&block);
        output.extend_from_slice(&block);
    }
    Ok(output)
}

fn cbc_decrypt<C: KeyInit + BlockCipherDecrypt<BlockSize = U16>>(
    algorithm: &Algorithm,
    key: &[u8],
    data: &[u8],
) -> Outcome<Vec<u8>> {
    let mut previous = iv(algorithm)?;
    if data.is_empty() || !data.len().is_multiple_of(BLOCK) {
        return Err(Failure::operation(
            "the AES-CBC ciphertext is not whole blocks",
        ));
    }
    let cipher: C = cipher(key)?;
    let mut output = Vec::with_capacity(data.len());
    for chunk in data.chunks(BLOCK) {
        let mut block = Array::<u8, U16>::try_from(chunk).expect("whole blocks");
        cipher.decrypt_block(&mut block);
        output.extend(block.iter().zip(previous.iter()).map(|(a, b)| a ^ b));
        previous.copy_from_slice(chunk);
    }
    let padding = usize::from(*output.last().expect("at least one block"));
    if padding == 0
        || padding > BLOCK
        || !output[output.len() - padding..]
            .iter()
            .all(|&byte| usize::from(byte) == padding)
    {
        return Err(Failure::operation("the AES-CBC padding is invalid"));
    }
    output.truncate(output.len() - padding);
    Ok(output)
}

/// GCM (SP 800-38D) with an iv of any nonzero length and any tag length
/// the Web Cryptography API allows.
fn gcm<C>(algorithm: &Algorithm, key: &[u8], data: &[u8], encrypt: bool) -> Outcome<Vec<u8>>
where
    C: KeyInit + BlockCipherEncrypt<BlockSize = U16>,
{
    let iv = algorithm.iv.as_deref().unwrap_or_default();
    if iv.is_empty() {
        return Err(Failure::operation("the AES-GCM iv is empty"));
    }
    let tag_length = match algorithm.tag_length.unwrap_or(128) {
        length @ (32 | 64 | 96 | 104 | 112 | 120 | 128) => length as usize / 8,
        _ => return Err(Failure::operation("unsupported AES-GCM tag length")),
    };
    let additional_data = algorithm.additional_data.as_deref().unwrap_or_default();
    let cipher: C = cipher(key)?;
    let mut subkey = Array::default();
    cipher.encrypt_block(&mut subkey);
    let ghash = |parts: [&[u8]; 2]| {
        let mut hash = GHash::new(&subkey);
        let mut lengths = [0u8; BLOCK];
        for (part, length) in parts.into_iter().zip(lengths.chunks_mut(8)) {
            hash.update_padded(part);
            length.copy_from_slice(&(part.len() as u64 * 8).to_be_bytes());
        }
        hash.update_padded(&lengths);
        hash.finalize()
    };
    let mut counter: [u8; BLOCK] = if iv.len() == 12 {
        let mut block = [0; BLOCK];
        block[..12].copy_from_slice(iv);
        block[15] = 1;
        block
    } else {
        ghash([&[], iv]).into()
    };
    let mut mask = Array::from(counter);
    cipher.encrypt_block(&mut mask);
    let tag = |ciphertext: &[u8]| {
        let hash = ghash([additional_data, ciphertext]);
        let mut tag: Vec<u8> = hash.iter().zip(mask.iter()).map(|(a, b)| a ^ b).collect();
        tag.truncate(tag_length);
        tag
    };
    let mut apply = |input: &[u8]| {
        let mut output = Vec::with_capacity(input.len() + tag_length);
        for chunk in input.chunks(BLOCK) {
            let low = u32::from_be_bytes(counter[12..].try_into().expect("four bytes"));
            counter[12..].copy_from_slice(&low.wrapping_add(1).to_be_bytes());
            let mut stream = Array::from(counter);
            cipher.encrypt_block(&mut stream);
            output.extend(chunk.iter().zip(stream.iter()).map(|(a, b)| a ^ b));
        }
        output
    };
    if encrypt {
        let mut output = apply(data);
        let tag = tag(&output);
        output.extend_from_slice(&tag);
        return Ok(output);
    }
    let Some(split) = data.len().checked_sub(tag_length) else {
        return Err(Failure::operation(
            "the AES-GCM ciphertext is shorter than the tag",
        ));
    };
    let (ciphertext, received) = data.split_at(split);
    let difference = tag(ciphertext)
        .iter()
        .zip(received)
        .fold(0, |difference, (a, b)| difference | (a ^ b));
    if difference != 0 {
        return Err(Failure::operation("the AES-GCM tag does not match"));
    }
    Ok(apply(ciphertext))
}

fn wrap<C: KeyInit + BlockCipherEncrypt<BlockSize = U16>>(
    key: &[u8],
    data: &[u8],
) -> Outcome<Vec<u8>> {
    if data.len() < 16 || !data.len().is_multiple_of(8) {
        return Err(Failure::operation("AES-KW wraps whole 64-bit blocks"));
    }
    let kw = AesKw::<C>::new_from_slice(key).map_err(|_| Failure::operation("invalid AES key"))?;
    let mut buffer = vec![0; data.len() + 8];
    let length = kw
        .wrap_key(data, &mut buffer)
        .map_err(|_| Failure::operation("AES-KW wrapping failed"))?
        .len();
    buffer.truncate(length);
    Ok(buffer)
}

fn unwrap<C: KeyInit + BlockCipherEncrypt<BlockSize = U16> + BlockCipherDecrypt>(
    key: &[u8],
    data: &[u8],
) -> Outcome<Vec<u8>> {
    if data.len() < 24 || !data.len().is_multiple_of(8) {
        return Err(Failure::operation(
            "the AES-KW input is not whole 64-bit blocks",
        ));
    }
    let kw = AesKw::<C>::new_from_slice(key).map_err(|_| Failure::operation("invalid AES key"))?;
    let mut buffer = vec![0; data.len() - 8];
    let length = kw
        .unwrap_key(data, &mut buffer)
        .map_err(|_| Failure::operation("the AES-KW integrity check failed"))?
        .len();
    buffer.truncate(length);
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::message::Bytes;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }

    fn algorithm(name: &str) -> Algorithm {
        Algorithm {
            name: name.into(),
            ..Algorithm::default()
        }
    }

    #[test]
    fn ctr_and_cbc_match_sp_800_38a() {
        let key = Key::secret(hex("2b7e151628aed2a6abf7158809cf4f3c"));
        let plain = hex("6bc1bee22e409f96e93d7e117393172a");
        let mut ctr = algorithm("AES-CTR");
        ctr.counter = Some(Bytes(hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff")));
        ctr.length = Some(128);
        assert_eq!(
            encrypt(&ctr, &key, &plain).unwrap(),
            hex("874d6191b620e3261bef6864990db6ce")
        );
        let mut cbc = algorithm("AES-CBC");
        cbc.iv = Some(Bytes(hex("000102030405060708090a0b0c0d0e0f")));
        let sealed = encrypt(&cbc, &key, &plain).unwrap();
        assert_eq!(&sealed[..16], &hex("7649abac8119b246cee98e9b12e9197d")[..]);
        assert_eq!(decrypt(&cbc, &key, &sealed).unwrap(), plain);
        assert_eq!(
            decrypt(&cbc, &key, &sealed[..16]).unwrap_err().name,
            "OperationError"
        );
    }

    #[test]
    fn ctr_counts_only_the_low_bits() {
        let key = Key::secret(vec![7; 16]);
        let mut ctr = algorithm("AES-CTR");
        ctr.counter = Some(Bytes(vec![0xff; 16]));
        ctr.length = Some(1);
        assert!(encrypt(&ctr, &key, &[0; 32]).is_ok());
        assert_eq!(
            encrypt(&ctr, &key, &[0; 33]).unwrap_err().name,
            "OperationError"
        );
    }

    #[test]
    fn gcm_and_kw_round_trip_and_authenticate() {
        let key = Key::secret(vec![1; 32]);
        for tag in [32, 64, 96, 104, 112, 120, 128] {
            let mut gcm = algorithm("AES-GCM");
            gcm.iv = Some(Bytes(vec![2; 12]));
            gcm.tag_length = Some(tag);
            gcm.additional_data = Some(Bytes(b"header".to_vec()));
            let mut sealed = encrypt(&gcm, &key, b"message").unwrap();
            assert_eq!(sealed.len(), 7 + tag as usize / 8);
            assert_eq!(decrypt(&gcm, &key, &sealed).unwrap(), b"message");
            sealed[0] ^= 1;
            assert!(decrypt(&gcm, &key, &sealed).is_err());
        }
        // The GCM specification's test cases 2 (96-bit iv) and 6 (480-bit iv).
        let mut gcm = algorithm("AES-GCM");
        gcm.iv = Some(Bytes(vec![0; 12]));
        assert_eq!(
            encrypt(&gcm, &Key::secret(vec![0; 16]), &[0; 16]).unwrap(),
            hex("0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf")
        );
        gcm.iv = Some(Bytes(hex(concat!(
            "9313225df88406e555909c5aff5269aa6a7a9538534f7da1e4c303d2a318a728",
            "c3c0c95156809539fcf0e2429a6b525416aedbf5a0de6a57a637b39b"
        ))));
        gcm.additional_data = Some(Bytes(hex("feedfacedeadbeeffeedfacedeadbeefabaddad2")));
        let plaintext = hex(concat!(
            "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72",
            "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39"
        ));
        let sealed = encrypt(
            &gcm,
            &Key::secret(hex("feffe9928665731c6d6a8f9467308308")),
            &plaintext,
        );
        assert_eq!(
            sealed.unwrap(),
            hex(concat!(
                "8ce24998625615b603a033aca13fb894be9112a5c3a211a8ba262a3cca7e2ca7",
                "01e4a9a4fba43c90ccdcb281d48c7c6fd62875d2aca417034c34aee5",
                "619cc5aefffe0bfa462af43c1699d050"
            ))
        );
        // RFC 3394 section 4.1.
        let kek = Key::secret(hex("000102030405060708090a0b0c0d0e0f"));
        let wrapped = encrypt(
            &algorithm("AES-KW"),
            &kek,
            &hex("00112233445566778899aabbccddeeff"),
        )
        .unwrap();
        assert_eq!(
            wrapped,
            hex("1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5")
        );
        assert!(decrypt(&algorithm("AES-KW"), &kek, &wrapped).is_ok());
    }
}

use std::collections::BTreeMap;

use bytes::Bytes;
use serde_json::{Value, json};

use crate::limits::check_limit;
use crate::{ByteHandles, Error, Invocation, WebLimits};

use super::codec::{Codec, Format};

/// The codecs open in one invocation, by id.
#[derive(Default)]
pub(crate) struct Codecs {
    open: BTreeMap<u64, Codec>,
    next: u64,
}

/// `compression.open [format, decompress]` returns an id; `write [id,
/// handle]` adds input; `finish id` ends it; `read id` returns a handle to
/// the next piece of output or null; `close id` drops the codec.
pub(crate) fn dispatch<B: ByteHandles>(
    operation: &str,
    input: &str,
    limits: &WebLimits,
    invocation: Invocation<'_, B>,
) -> Result<Value, B::Error> {
    let invalid = || Error::InvalidRequest("invalid compression message".into());
    let codecs = &mut invocation.state.codecs;
    if operation == "compression.open" {
        let (format, decompress): (String, bool) =
            serde_json::from_str(input).map_err(|_| invalid())?;
        let format = Format::parse(&format).ok_or_else(invalid)?;
        check_limit(
            limits.compression_streams,
            codecs.open.len() + 1,
            "compression streams",
        )?;
        let codec = if decompress {
            Codec::decompressor(format, limits.decompressed_bytes)
        } else {
            Codec::compressor(format)
        };
        codecs.next += 1;
        codecs.open.insert(codecs.next, codec);
        return Ok(json!(codecs.next));
    }
    if operation == "compression.write" {
        let (id, handle): (u64, u64) = serde_json::from_str(input).map_err(|_| invalid())?;
        let bytes = invocation.bytes.take(handle)?;
        let codec = codecs.open.get_mut(&id).ok_or_else(invalid)?;
        codec.write(&bytes)?;
        return Ok(Value::Null);
    }
    let id: u64 = serde_json::from_str(input).map_err(|_| invalid())?;
    if operation == "compression.close" {
        codecs.open.remove(&id);
        return Ok(Value::Null);
    }
    let codec = codecs.open.get_mut(&id).ok_or_else(invalid)?;
    match operation {
        "compression.finish" => {
            codec.finish();
            Ok(Value::Null)
        }
        "compression.read" => match codec.read()? {
            Some(piece) => Ok(json!(invocation.bytes.put(Bytes::from(piece))?)),
            None => Ok(Value::Null),
        },
        _ => Err(Error::UnknownOperation.into()),
    }
}

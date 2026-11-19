use std::collections::BTreeMap;

use bytes::Bytes;
use serde_json::{Value, json};

use crate::limits::check_limit;
use crate::{ByteHandles, Error, Invocation, WebLimits};

use super::codec::{Codec, Format};

/// The codecs open in one invocation, by id.
#[derive(Default)]
pub(crate) struct Codecs {
    open: BTreeMap<u64, OpenCodec>,
    next: u64,
}

/// A codec and the handle of its last output, which the guest takes before
/// the next read. With the codec's own input rule, an open stream holds at
/// most one piece of output and one write of input outside the guest's heap.
struct OpenCodec {
    codec: Codec,
    output: Option<u64>,
}

/// `compression.open [format, decompress]` returns an id; `write [id,
/// handle]` adds input, once reads have drained the previous input; `finish
/// id` ends it; `read id` returns a handle to the next piece of output or
/// null, once the guest took the previous piece; `close id` drops the codec.
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
        codecs.open.insert(
            codecs.next,
            OpenCodec {
                codec,
                output: None,
            },
        );
        return Ok(json!(codecs.next));
    }
    if operation == "compression.write" {
        let (id, handle): (u64, u64) = serde_json::from_str(input).map_err(|_| invalid())?;
        let bytes = invocation.bytes.take(handle)?;
        let open = codecs.open.get_mut(&id).ok_or_else(invalid)?;
        open.codec.write(&bytes)?;
        return Ok(Value::Null);
    }
    let id: u64 = serde_json::from_str(input).map_err(|_| invalid())?;
    if operation == "compression.close" {
        if let Some(open) = codecs.open.remove(&id) {
            release(invocation.bytes, open.output);
        }
        return Ok(Value::Null);
    }
    let open = codecs.open.get_mut(&id).ok_or_else(invalid)?;
    match operation {
        "compression.finish" => {
            open.codec.finish();
            Ok(Value::Null)
        }
        "compression.read" => {
            // A previous piece still in the byte store is dropped and the
            // read fails: output is produced only as fast as it is taken.
            if release(invocation.bytes, open.output.take()) {
                return Err(Error::InvalidRequest(
                    "the previous compression output was not taken".into(),
                )
                .into());
            }
            match open.codec.read()? {
                Some(piece) => {
                    let handle = invocation.bytes.put(Bytes::from(piece))?;
                    open.output = Some(handle);
                    Ok(json!(handle))
                }
                None => Ok(Value::Null),
            }
        }
        _ => Err(Error::UnknownOperation.into()),
    }
}

/// Drop an output piece the guest has not taken; whether one was there.
fn release<B: ByteHandles>(bytes: &mut B, output: Option<u64>) -> bool {
    output.is_some_and(|handle| bytes.take(handle).is_ok())
}

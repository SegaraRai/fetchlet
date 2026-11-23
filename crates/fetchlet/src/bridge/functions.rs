//! Calls of `Functions` methods: the message JavaScript sends, the async
//! calls an invocation waits for, and the outcome JavaScript settles with.

use std::collections::BTreeMap;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::task::{Context, Poll};

use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Value, json};

use super::handles::Handles;
use crate::pointer::{self, Placed};
use crate::wire::ByteStore;
use crate::{Error, FunctionError, FunctionFuture, FunctionResponse, Result};

/// `function.call` and `function.start`: a method of a binding, with the
/// arguments as `JSON.stringify` encoded them and their byte arrays beside.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CallMessage {
    pub binding: String,
    pub method: String,
    pub args: Vec<Value>,
    #[serde(default)]
    pub bytes: Option<ArgumentBytes>,
}

/// The byte arrays of the arguments: one buffer in the byte store, cut into
/// parts in order, each for the path where JavaScript passed it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ArgumentBytes {
    handle: u64,
    parts: Vec<BytePart>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BytePart {
    path: Vec<String>,
    length: usize,
}

/// The arguments of `message`, with the byte arrays it lists taken from
/// `store` and checked against the JSON: each at a distinct value of the
/// argument list, which holds `null` there.
pub(super) fn arguments(
    args: Vec<Value>,
    bytes: Option<ArgumentBytes>,
    store: &mut ByteStore,
) -> Result<(Value, Placed<Bytes>)> {
    let mut args = Value::Array(args);
    let Some(ArgumentBytes { handle, parts }) = bytes else {
        return Ok((args, Vec::new()));
    };
    let buffer = store.take(handle)?;
    let mut placed: Placed<Bytes> = Vec::with_capacity(parts.len());
    let mut offset = 0usize;
    for BytePart { path, length } in parts {
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= buffer.len())
            .ok_or_else(|| pointer::invalid("byte parts exceed their buffer"))?;
        if path.is_empty()
            || pointer::overlaps(placed.iter().map(|(path, _)| path.as_slice()), &path)
            || !pointer::clear(&mut args, &path)
        {
            return Err(pointer::invalid("a byte part needs its own argument value"));
        }
        placed.push((path, buffer.slice(offset..end)));
        offset = end;
    }
    if offset != buffer.len() {
        return Err(pointer::invalid("byte parts do not fill their buffer"));
    }
    Ok((args, placed))
}

/// The async calls of an invocation, by ticket. Dropping one cancels it.
#[derive(Default)]
pub(super) struct PendingCalls {
    calls: BTreeMap<String, FunctionFuture>,
}

impl PendingCalls {
    pub fn insert(&mut self, ticket: String, future: FunctionFuture) {
        self.calls.insert(ticket, future);
    }

    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    /// Poll every call, and add the outcome of each finished one to
    /// `completed` with its ticket. A call that panics fails, as a sync
    /// method that panics does.
    pub fn poll(
        &mut self,
        context: &mut Context<'_>,
        result_bytes: Option<usize>,
        resources: &mut Resources<'_>,
        completed: &mut Vec<(String, Value)>,
    ) {
        self.calls.retain(|ticket, future| {
            let result = match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(context))) {
                Ok(Poll::Pending) => return true,
                Ok(Poll::Ready(result)) => result,
                Err(_) => Err(FunctionError::panicked()),
            };
            completed.push((ticket.clone(), outcome(result, result_bytes, resources)));
            false
        });
    }
}

/// Where the byte arrays and channels of results go: the invocation's byte
/// store and handle table.
pub(super) struct Resources<'a> {
    pub bytes: &'a mut ByteStore,
    pub handles: &'a mut Handles,
}

/// Run a sync method, failing the call if it panics.
pub(super) fn run_sync(
    method: impl FnOnce() -> std::result::Result<FunctionResponse, FunctionError>,
) -> std::result::Result<FunctionResponse, FunctionError> {
    catch_unwind(AssertUnwindSafe(method)).unwrap_or_else(|_| Err(FunctionError::panicked()))
}

/// Start an async method, failing the call if building its future panics.
pub(super) fn start_async(method: impl FnOnce() -> FunctionFuture) -> FunctionFuture {
    catch_unwind(AssertUnwindSafe(method))
        .unwrap_or_else(|_| Box::pin(std::future::ready(Err(FunctionError::panicked()))))
}

/// What JavaScript settles the call with: `{ ok, value, bytes, channels }`
/// or `{ ok, error }`. A result's JSON is one bridge message to the guest,
/// so `bridge_message_bytes` bounds it as it bounds the arguments. Its byte
/// arrays go to the byte store, and its channels into the handle table,
/// lent to the invocation.
pub(super) fn outcome(
    result: std::result::Result<FunctionResponse, FunctionError>,
    result_bytes: Option<usize>,
    resources: &mut Resources<'_>,
) -> Value {
    match result.and_then(|response| encode(response, result_bytes, resources).map_err(Into::into))
    {
        Ok(value) => value,
        Err(error) => json!({ "ok": false, "error": error.describe() }),
    }
}

fn encode(
    response: FunctionResponse,
    result_bytes: Option<usize>,
    resources: &mut Resources<'_>,
) -> Result<Value> {
    let (value, bytes, channels) = response.into_parts();
    if result_bytes.is_some_and(|limit| json_len(&value) > limit) {
        return Err(Error::LimitExceeded("bridge message bytes"));
    }
    let bytes = bytes
        .into_iter()
        .map(|(path, bytes)| {
            let handle = resources.bytes.put(bytes)?;
            Ok(json!({ "path": path, "handle": handle }))
        })
        .collect::<Result<Vec<_>>>()?;
    let channels = channels
        .into_iter()
        .map(|(path, end)| {
            // Rust's end is ready, so the channel opens at the next poll.
            let channel = resources
                .handles
                .open_requested(end, Box::pin(async { Ok(()) }))?;
            Ok(json!({ "path": path, "channel": channel }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "ok": true, "value": value, "bytes": bytes, "channels": channels }))
}

/// The length of `value` as JSON, without keeping the text.
fn json_len(value: &Value) -> usize {
    struct Count(usize);
    impl io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    // Writing a Value to a counter cannot fail.
    let _ = serde_json::to_writer(&mut count, value);
    count.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(path: &[&str], length: usize) -> BytePart {
        BytePart {
            path: path.iter().map(|token| (*token).to_owned()).collect(),
            length,
        }
    }

    fn take(args: Value, parts: Vec<BytePart>, buffer: &'static [u8]) -> Result<Value> {
        let mut store = ByteStore::default();
        let handle = store.put_guest(Bytes::from_static(buffer))?;
        let Value::Array(args) = args else {
            unreachable!()
        };
        arguments(args, Some(ArgumentBytes { handle, parts }), &mut store).map(|(args, _)| args)
    }

    #[test]
    fn byte_parts_must_fill_distinct_argument_values() {
        let args = serde_json::json!([null, { "a": null }]);
        assert!(
            take(
                args.clone(),
                vec![part(&["0"], 1), part(&["1", "a"], 2)],
                b"abc"
            )
            .is_ok()
        );
        for parts in [
            vec![part(&["0"], 1)],
            vec![part(&["0"], 4)],
            vec![part(&["0"], 1), part(&["0"], 2)],
            vec![part(&["1"], 1), part(&["1", "a"], 2)],
            vec![part(&[], 3)],
            vec![part(&["2"], 3)],
        ] {
            assert!(take(args.clone(), parts, b"abc").is_err());
        }
    }
}

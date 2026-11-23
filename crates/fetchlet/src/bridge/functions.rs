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
use crate::placed::{ByteLayout, Placed};
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
    pub bytes: Option<ByteLayout>,
}

/// The arguments of a call, with the byte arrays `bytes` lists taken from
/// `store`: each at a distinct value inside the argument list, which holds
/// `null` there.
pub(super) fn arguments(
    args: Vec<Value>,
    bytes: Option<ByteLayout>,
    store: &mut ByteStore,
) -> Result<(Value, Placed<Bytes>)> {
    let mut args = Value::Array(args);
    let Some(layout) = bytes else {
        return Ok((args, Vec::new()));
    };
    let buffer = store.take(layout.handle())?;
    let placed = layout.split(&mut args, buffer, false)?;
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

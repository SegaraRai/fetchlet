//! Calls of `Functions` methods: the message JavaScript sends, the async
//! calls an invocation waits for, and the outcome JavaScript settles with.

use std::collections::BTreeMap;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::task::{Context, Poll};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, FunctionError, FunctionFuture};

/// `function.call` and `function.start`: a method of a binding, with the
/// arguments as `JSON.stringify` encoded them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CallMessage {
    pub binding: String,
    pub method: String,
    pub args: Vec<Value>,
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
        completed: &mut Vec<(String, Value)>,
    ) {
        self.calls.retain(|ticket, future| {
            let result = match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(context))) {
                Ok(Poll::Pending) => return true,
                Ok(Poll::Ready(result)) => result,
                Err(_) => Err(FunctionError::panicked()),
            };
            completed.push((ticket.clone(), outcome(result, result_bytes)));
            false
        });
    }
}

/// Run a sync method, failing the call if it panics.
pub(super) fn run_sync(
    method: impl FnOnce() -> Result<Value, FunctionError>,
) -> Result<Value, FunctionError> {
    catch_unwind(AssertUnwindSafe(method)).unwrap_or_else(|_| Err(FunctionError::panicked()))
}

/// Start an async method, failing the call if building its future panics.
pub(super) fn start_async(method: impl FnOnce() -> FunctionFuture) -> FunctionFuture {
    catch_unwind(AssertUnwindSafe(method))
        .unwrap_or_else(|_| Box::pin(std::future::ready(Err(FunctionError::panicked()))))
}

/// What JavaScript settles the call with: `{ ok, value }` or `{ ok, error }`.
/// A result is one bridge message to the guest, so `bridge_message_bytes`
/// bounds its JSON as it bounds the arguments.
pub(super) fn outcome(result: Result<Value, FunctionError>, result_bytes: Option<usize>) -> Value {
    let result = result.and_then(|value| match result_bytes {
        Some(limit) if json_len(&value) > limit => {
            Err(Error::LimitExceeded("bridge message bytes").into())
        }
        _ => Ok(value),
    });
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error.describe() }),
    }
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

use std::fmt;

use bytes::Bytes;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{FunctionError, args};
use crate::pointer::Placed;
use crate::{Context, Limits};

/// What a [`Functions`](super::Functions) method receives when JavaScript
/// calls it: the method's name, its arguments and the invocation's trusted
/// `Context`.
pub struct FunctionRequest {
    method: String,
    args: Value,
    /// Each byte array of the arguments, by its path in them; `args` holds
    /// `null` there.
    bytes: Placed<Bytes>,
    context: Context,
    limits: Limits,
}

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
impl FunctionRequest {
    pub(crate) fn new(
        method: String,
        args: Value,
        bytes: Placed<Bytes>,
        context: Option<Context>,
        limits: Limits,
    ) -> Self {
        Self {
            method,
            args,
            bytes,
            context: context.unwrap_or_default(),
            limits,
        }
    }
}

impl FunctionRequest {
    /// The name of the method JavaScript called.
    pub fn method(&self) -> &str {
        &self.method
    }

    /// The trusted values the caller attached to the invocation, empty when
    /// it attached none. JavaScript cannot read or change them.
    pub fn context(&self) -> &Context {
        &self.context
    }

    /// The budgets of the invocation, for the channels a
    /// [`FunctionResponse`](super::FunctionResponse) lends to JavaScript.
    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// The arguments as `T`, usually a tuple with one element per argument,
    /// or `Vec<Value>` for any number. A tuple needs exactly its number of
    /// arguments; an argument JavaScript passes as `undefined` arrives as
    /// `null`.
    ///
    /// An `ArrayBuffer` or view, such as a `Uint8Array`, anywhere in the
    /// arguments arrives as its bytes, without a JSON encoding: read it as
    /// `Vec<u8>`, `bytes::Bytes` with its `serde` feature, or another type
    /// that deserializes from bytes or a sequence of them.
    ///
    /// Arguments that do not deserialize fail the call with a `TypeError`
    /// in JavaScript that names the method.
    pub fn args<T: DeserializeOwned>(&self) -> Result<T, FunctionError> {
        args::deserialize(&self.args, &self.bytes)
            .map_err(|error| FunctionError::arguments(error.to_string()))
    }

    /// The arguments as the JSON array JavaScript sent, with `null` at the
    /// position of each byte array.
    pub fn raw_args(&self) -> &Value {
        &self.args
    }
}

impl fmt::Debug for FunctionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FunctionRequest")
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}

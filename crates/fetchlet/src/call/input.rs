use bytes::Bytes;
use serde_json::Value;

use crate::host::{GuestEnd, pair};
use crate::placed::{self, Placed};
use crate::{ChannelEnd, Context, Limits, Result};

/// A call of an exported function: its arguments, which are JSON values,
/// byte arrays and channels Rust lends to it, and the trusted `Context` of
/// its invocation.
///
/// ```ignore
/// let mut call = Call::new("transcode");
/// call.json(json!({ "format": "webm", "progress": null }));
/// call.bytes(source);
/// let progress = call.channel_at("/0/progress", app.limits())?;
/// call.context(Context::new().with(Tenant("a".into())));
/// let output = app.call_with(call).await?;
/// ```
///
/// JavaScript receives each byte array as a `Uint8Array` and each lent
/// channel as a channel object, with the `opened`, `closed`, `socket()` and
/// `stream()` of an env binding's channel, at the argument position Rust
/// named; Rust keeps the [`ChannelEnd`]. Positions are JSON Pointers into
/// the argument list, so no JSON shape is reserved for them. A lent channel
/// belongs to the call's invocation and closes when it ends, as a channel
/// JavaScript opens does; it does not count against `Limits::open_channels`,
/// which bounds what JavaScript opens. Channels need the fetchlet Web API
/// profile, which builds the channel objects; without it the call fails.
///
/// The context reaches the [`Functions`](crate::Functions) methods
/// JavaScript calls during the invocation, as
/// [`FunctionRequest::context`](crate::FunctionRequest::context), and its
/// host fetches, as the context of a Fetch request does. JavaScript cannot
/// read it.
pub struct Call {
    export: String,
    arguments: Vec<Value>,
    bytes: Placed<Bytes>,
    channels: Placed<GuestEnd>,
    context: Option<Context>,
}

/// What a [`Call`] carries, for the App that runs it.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) struct CallParts {
    pub export: String,
    pub arguments: Vec<Value>,
    pub bytes: Placed<Bytes>,
    pub channels: Placed<GuestEnd>,
    pub context: Option<Context>,
}

impl std::fmt::Debug for Call {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Call")
            .field("export", &self.export)
            .field("arguments", &self.arguments)
            .field(
                "bytes",
                &self.bytes.iter().map(|(path, _)| path).collect::<Vec<_>>(),
            )
            .field(
                "channels",
                &self
                    .channels
                    .iter()
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

impl Call {
    pub fn new(export: impl Into<String>) -> Self {
        Self::with_arguments(export.into(), Vec::new())
    }

    /// The JSON arguments of `call_json`.
    pub(crate) fn with_arguments(export: String, arguments: Vec<Value>) -> Self {
        Self {
            export,
            arguments,
            bytes: Vec::new(),
            channels: Vec::new(),
            context: None,
        }
    }

    /// Add a JSON argument.
    pub fn json(&mut self, value: Value) -> &mut Self {
        self.arguments.push(value);
        self
    }

    /// Add a byte array argument, which JavaScript receives as a
    /// `Uint8Array`.
    pub fn bytes(&mut self, bytes: impl Into<Bytes>) -> &mut Self {
        let path = self.push_position();
        self.bytes.push((path, bytes.into()));
        self
    }

    /// Put a byte array at `pointer`, a JSON Pointer into the argument list
    /// such as `/0/image`, replacing the value there, as
    /// [`channel_at`](Self::channel_at) lends a channel.
    pub fn bytes_at(&mut self, pointer: &str, bytes: impl Into<Bytes>) -> Result<&mut Self> {
        let path = self.place(pointer)?;
        self.bytes.push((path, bytes.into()));
        Ok(self)
    }

    /// Add a channel argument and return Rust's end of it. The channel's
    /// budgets come from `limits`: pass the App's, as the channels
    /// JavaScript opens have.
    pub fn channel(&mut self, limits: &Limits) -> ChannelEnd {
        let path = self.push_position();
        self.lend(path, limits)
    }

    /// Lend a channel at `pointer`, a JSON Pointer into the argument list
    /// such as `/0/progress`, and return Rust's end of it. The value there
    /// must exist; the channel object replaces it. Fails with
    /// `InvalidRequest` for a pointer that names no value, the list itself,
    /// or a position inside or around another byte array or channel.
    pub fn channel_at(&mut self, pointer: &str, limits: &Limits) -> Result<ChannelEnd> {
        let path = self.place(pointer)?;
        Ok(self.lend(path, limits))
    }

    /// Attach trusted values to the call's invocation, replacing any
    /// attached before.
    pub fn context(&mut self, context: Context) -> &mut Self {
        self.context = Some(context);
        self
    }

    pub fn export(&self) -> &str {
        &self.export
    }

    /// A new `null` argument for a resource, by its path.
    fn push_position(&mut self) -> Vec<String> {
        self.arguments.push(Value::Null);
        vec![(self.arguments.len() - 1).to_string()]
    }

    /// Clear the argument value at `pointer` for a resource, if no other
    /// holds it.
    fn place(&mut self, pointer: &str) -> Result<Vec<String>> {
        let path = placed::parse(pointer)?;
        let taken = self
            .bytes
            .iter()
            .map(|(path, _)| path.as_slice())
            .chain(self.channels.iter().map(|(path, _)| path.as_slice()));
        if placed::overlaps(taken, &path) {
            return Err(placed::invalid(
                "the pointer overlaps another byte array or channel",
            ));
        }
        let mut list = Value::Array(std::mem::take(&mut self.arguments));
        let found = !path.is_empty() && placed::clear(&mut list, &path);
        let Value::Array(arguments) = list else {
            unreachable!("the argument list stays an array");
        };
        self.arguments = arguments;
        if !found {
            return Err(placed::invalid("the pointer names no argument value"));
        }
        Ok(path)
    }

    fn lend(&mut self, path: Vec<String>, limits: &Limits) -> ChannelEnd {
        let (end, guest) = pair(limits);
        self.channels.push((path, guest));
        end
    }

    #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
    pub(crate) fn into_parts(self) -> CallParts {
        CallParts {
            export: self.export,
            arguments: self.arguments,
            bytes: self.bytes,
            channels: self.channels,
            context: self.context,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Error;

    fn paths<T>(placed: &Placed<T>) -> Vec<Vec<String>> {
        placed.iter().map(|(path, _)| path.clone()).collect()
    }

    #[test]
    fn resources_take_their_positions() {
        let limits = Limits::default();
        let mut call = Call::new("run");
        call.json(json!({ "a/b": { "x": 1 }, "list": [1, 2], "image": 3 }));
        let _positional = call.channel(&limits);
        call.bytes(b"raw".to_vec());
        call.channel_at("/0/a~1b", &limits).unwrap();
        call.channel_at("/0/list/1", &limits).unwrap();
        call.bytes_at("/0/image", Bytes::from_static(b"png"))
            .unwrap();
        assert_eq!(
            call.arguments,
            vec![
                json!({ "a/b": null, "list": [1, null], "image": null }),
                Value::Null,
                Value::Null
            ]
        );
        assert_eq!(
            paths(&call.channels),
            vec![vec!["1"], vec!["0", "a/b"], vec!["0", "list", "1"]]
        );
        assert_eq!(paths(&call.bytes), vec![vec!["2"], vec!["0", "image"]]);
    }

    #[test]
    fn pointers_must_name_a_free_value() {
        let limits = Limits::default();
        let mut call = Call::new("run");
        call.json(json!({ "a": { "b": 1 }, "c": 2, "d": 3 }));
        call.channel_at("/0/a", &limits).unwrap();
        call.bytes_at("/0/d", Bytes::new()).unwrap();
        for pointer in ["", "0", "/1", "/0/missing", "/0/a", "/0/a/b", "/0", "/0/d"] {
            assert!(
                matches!(
                    call.channel_at(pointer, &limits),
                    Err(Error::InvalidRequest(_))
                ),
                "{pointer}"
            );
            assert!(
                matches!(
                    call.bytes_at(pointer, Bytes::new()),
                    Err(Error::InvalidRequest(_))
                ),
                "{pointer}"
            );
        }
        call.channel_at("/0/c", &limits).unwrap();
    }
}

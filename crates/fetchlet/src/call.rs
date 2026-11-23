use serde_json::Value;

use crate::host::{GuestEnd, pair};
use crate::{ChannelEnd, Limits, Result, pointer};

/// A call of an exported function whose arguments are JSON values and
/// channels Rust lends to it.
///
/// ```ignore
/// let mut call = Call::new("transcode");
/// call.json(json!({ "format": "webm", "progress": null }));
/// let progress = call.channel_at("/0/progress", app.limits())?;
/// let input = call.channel(app.limits());
/// let result = app.call_with(call).await?;
/// ```
///
/// JavaScript receives each lent channel as a channel object, with the
/// `opened`, `closed`, `socket()` and `stream()` of an env binding's
/// channel, at the argument position Rust named; Rust keeps the
/// [`ChannelEnd`]. Positions are JSON Pointers into the argument list, so
/// no JSON shape is reserved for them. A lent channel belongs to the call's
/// invocation and closes when it ends, as a channel JavaScript opens does;
/// it does not count against `Limits::open_channels`, which bounds what
/// JavaScript opens. Channels need the fetchlet Web API profile, which
/// builds the channel objects; without it the call fails.
pub struct Call {
    export: String,
    arguments: Vec<Value>,
    lent: Vec<Lent>,
}

/// A channel lent to a call, and where its object goes.
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
pub(crate) struct Lent {
    pub path: Vec<String>,
    pub end: GuestEnd,
}

impl std::fmt::Debug for Call {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Call")
            .field("export", &self.export)
            .field("arguments", &self.arguments)
            .field(
                "channels",
                &self.lent.iter().map(|lent| &lent.path).collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl Call {
    pub fn new(export: impl Into<String>) -> Self {
        Self {
            export: export.into(),
            arguments: Vec::new(),
            lent: Vec::new(),
        }
    }

    /// The JSON arguments of `call_json`.
    pub(crate) fn with_arguments(export: &str, arguments: &[Value]) -> Self {
        Self {
            export: export.to_owned(),
            arguments: arguments.to_vec(),
            lent: Vec::new(),
        }
    }

    /// Add a JSON argument.
    pub fn json(&mut self, value: Value) -> &mut Self {
        self.arguments.push(value);
        self
    }

    /// Add a channel argument and return Rust's end of it. The channel's
    /// budgets come from `limits`: pass the App's, as the channels
    /// JavaScript opens have.
    pub fn channel(&mut self, limits: &Limits) -> ChannelEnd {
        self.arguments.push(Value::Null);
        let path = vec![(self.arguments.len() - 1).to_string()];
        self.lend(path, limits)
    }

    /// Lend a channel at `pointer`, a JSON Pointer into the argument list
    /// such as `/0/progress`, and return Rust's end of it. The value there
    /// must exist; the channel object replaces it. Fails with
    /// `InvalidRequest` for a pointer that names no value, the list itself,
    /// or a position inside or around another lent channel.
    pub fn channel_at(&mut self, pointer: &str, limits: &Limits) -> Result<ChannelEnd> {
        let path = pointer::parse(pointer)?;
        if pointer::overlaps(self.lent.iter().map(|lent| lent.path.as_slice()), &path) {
            return Err(pointer::invalid(
                "the pointer overlaps another lent channel",
            ));
        }
        let mut list = Value::Array(std::mem::take(&mut self.arguments));
        let found = !path.is_empty() && pointer::clear(&mut list, &path);
        let Value::Array(arguments) = list else {
            unreachable!("the argument list stays an array");
        };
        self.arguments = arguments;
        if !found {
            return Err(pointer::invalid("the pointer names no argument value"));
        }
        Ok(self.lend(path, limits))
    }

    fn lend(&mut self, path: Vec<String>, limits: &Limits) -> ChannelEnd {
        let (end, guest) = pair(limits);
        self.lent.push(Lent { path, end: guest });
        end
    }

    pub fn export(&self) -> &str {
        &self.export
    }

    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub(crate) fn into_parts(self) -> (String, Vec<Value>, Vec<Lent>) {
        (self.export, self.arguments, self.lent)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Error;

    #[test]
    fn channels_take_their_positions() {
        let limits = Limits::default();
        let mut call = Call::new("run");
        call.json(json!({ "a/b": { "x": 1 }, "list": [1, 2] }));
        let _positional = call.channel(&limits);
        call.channel_at("/0/a~1b", &limits).unwrap();
        call.channel_at("/0/list/1", &limits).unwrap();
        let (_, arguments, lent) = call.into_parts();
        assert_eq!(
            arguments,
            vec![json!({ "a/b": null, "list": [1, null] }), Value::Null]
        );
        let paths: Vec<_> = lent.iter().map(|lent| lent.path.clone()).collect();
        assert_eq!(
            paths,
            vec![vec!["1"], vec!["0", "a/b"], vec!["0", "list", "1"]]
        );
    }

    #[test]
    fn pointers_must_name_a_free_value() {
        let limits = Limits::default();
        let mut call = Call::new("run");
        call.json(json!({ "a": { "b": 1 }, "c": 2 }));
        call.channel_at("/0/a", &limits).unwrap();
        for pointer in ["", "0", "/1", "/0/missing", "/0/a", "/0/a/b", "/0"] {
            assert!(
                matches!(
                    call.channel_at(pointer, &limits),
                    Err(Error::InvalidRequest(_))
                ),
                "{pointer}"
            );
        }
        call.channel_at("/0/c", &limits).unwrap();
    }
}

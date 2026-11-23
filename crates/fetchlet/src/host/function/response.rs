use std::fmt;

use bytes::Bytes;
use serde_json::Value;

use crate::host::{GuestEnd, pair};
use crate::placed::{self, Placed};
use crate::{ChannelEnd, Limits, Result};

/// The result of a [`Functions`](super::Functions) method: a JSON value,
/// with byte arrays and channels at positions inside it.
///
/// ```ignore
/// let mut response = FunctionResponse::new(json!({ "thumbnail": null, "progress": null }));
/// response.bytes_at("/thumbnail", thumbnail)?;
/// let progress = response.channel_at("/progress", request.limits())?;
/// tokio::spawn(report(progress));
/// Ok(response)
/// ```
///
/// JavaScript receives each byte array as a `Uint8Array` and each channel
/// as a channel object, with the `opened`, `closed`, `socket()` and
/// `stream()` of an env binding's channel, at the position Rust named; Rust
/// keeps the [`ChannelEnd`]. Positions are JSON Pointers into the value, so
/// no JSON shape is reserved for them, and the empty pointer makes the
/// whole result a byte array or a channel. A channel belongs to the
/// invocation and closes when it ends, as one JavaScript opens does; it does
/// not count against `Limits::open_channels`. Channels need the fetchlet Web
/// API profile, which builds the channel objects; without it the call
/// fails in JavaScript.
///
/// `serde_json::Value`, `Bytes` and `Vec<u8>` convert into a response.
pub struct FunctionResponse {
    value: Value,
    bytes: Placed<Bytes>,
    channels: Placed<GuestEnd>,
}

impl FunctionResponse {
    pub fn new(value: Value) -> Self {
        Self {
            value,
            bytes: Vec::new(),
            channels: Vec::new(),
        }
    }

    /// Put `bytes` at `pointer`, a JSON Pointer into the value such as
    /// `/thumbnail`, replacing the value there. Fails with `InvalidRequest`
    /// for a pointer that names no value, or a position inside or around
    /// another byte array or channel.
    pub fn bytes_at(&mut self, pointer: &str, bytes: impl Into<Bytes>) -> Result<&mut Self> {
        let path = self.place(pointer)?;
        self.bytes.push((path, bytes.into()));
        Ok(self)
    }

    /// Lend a channel at `pointer` and return Rust's end of it, as
    /// [`bytes_at`](Self::bytes_at) places bytes. The channel's budgets
    /// come from `limits`: pass the request's
    /// [`limits`](super::FunctionRequest::limits).
    pub fn channel_at(&mut self, pointer: &str, limits: &Limits) -> Result<ChannelEnd> {
        let path = self.place(pointer)?;
        let (end, guest) = pair(limits);
        self.channels.push((path, guest));
        Ok(end)
    }

    /// Clear the value at `pointer` for a resource, if no other holds it.
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
        if !placed::clear(&mut self.value, &path) {
            return Err(placed::invalid("the pointer names no value"));
        }
        Ok(path)
    }
}

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
impl FunctionResponse {
    /// The value, then each byte array and channel by its path.
    pub(crate) fn into_parts(self) -> (Value, Placed<Bytes>, Placed<GuestEnd>) {
        (self.value, self.bytes, self.channels)
    }
}

impl From<Value> for FunctionResponse {
    fn from(value: Value) -> Self {
        Self::new(value)
    }
}

impl From<Bytes> for FunctionResponse {
    fn from(bytes: Bytes) -> Self {
        Self {
            value: Value::Null,
            bytes: vec![(Vec::new(), bytes)],
            channels: Vec::new(),
        }
    }
}

impl From<Vec<u8>> for FunctionResponse {
    fn from(bytes: Vec<u8>) -> Self {
        Bytes::from(bytes).into()
    }
}

impl fmt::Debug for FunctionResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FunctionResponse")
            .field("value", &self.value)
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
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Error;

    #[test]
    fn resources_take_free_positions() {
        let limits = Limits::default();
        let mut response = FunctionResponse::new(json!({ "a": { "b": 1 }, "c": [1, 2] }));
        response.bytes_at("/a", Bytes::from_static(b"x")).unwrap();
        let _end = response.channel_at("/c/1", &limits).unwrap();
        for pointer in ["", "/a", "/a/b", "/c", "/c/1", "/missing", "c"] {
            assert!(
                matches!(
                    response.bytes_at(pointer, Bytes::new()),
                    Err(Error::InvalidRequest(_))
                ),
                "{pointer}"
            );
        }
        let (value, bytes, channels) = response.into_parts();
        assert_eq!(value, json!({ "a": null, "c": [1, null] }));
        assert_eq!(bytes[0].0, vec!["a"]);
        assert_eq!(channels[0].0, vec!["c", "1"]);
    }

    #[test]
    fn bytes_can_be_the_whole_result() {
        let (value, bytes, _) = FunctionResponse::from(b"raw".to_vec()).into_parts();
        assert_eq!(value, Value::Null);
        assert_eq!(bytes, vec![(Vec::new(), Bytes::from_static(b"raw"))]);
    }
}

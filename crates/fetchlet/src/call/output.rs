use std::fmt;

use bytes::Bytes;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::placed::{self, Placed};
use crate::{Error, Result};

/// The result of an exported function: the JSON value `JSON.stringify`
/// made of it, with each `ArrayBuffer` or view inside it as bytes.
///
/// ```ignore
/// let output = app.call_with(Call::new("thumbnail")).await?;
/// let (name, image): (String, Vec<u8>) = output.deserialize()?;
/// ```
///
/// The value holds `null` at the position of each byte array.
/// [`deserialize`](Self::deserialize) reads the byte arrays where they
/// were, as [`FunctionRequest::args`](crate::FunctionRequest::args) reads
/// a method's arguments.
pub struct CallOutput {
    value: Value,
    bytes: Placed<Bytes>,
}

impl CallOutput {
    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub(crate) fn new(value: Value, bytes: Placed<Bytes>) -> Self {
        Self { value, bytes }
    }

    /// The result as JSON, with `null` at each byte array.
    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn into_value(self) -> Value {
        self.value
    }

    /// The byte array at `pointer`, a JSON Pointer into the result such as
    /// `/image`; the empty pointer names a result that is a byte array.
    pub fn bytes_at(&self, pointer: &str) -> Option<&Bytes> {
        let path = placed::parse(pointer).ok()?;
        self.bytes
            .iter()
            .find(|(placed, _)| *placed == path)
            .map(|(_, bytes)| bytes)
    }

    /// The result as `T`, with each byte array read where it was, into
    /// `Vec<u8>`, `bytes::Bytes` with its `serde` feature, or another type
    /// that deserializes from bytes. Fails with `Error::JavaScript` when the
    /// result does not deserialize.
    pub fn deserialize<T: DeserializeOwned>(&self) -> Result<T> {
        placed::deserialize(&self.value, &self.bytes)
            .map_err(|error| Error::JavaScript(format!("invalid result: {error}")))
    }
}

impl fmt::Debug for CallOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CallOutput")
            .field("value", &self.value)
            .field(
                "bytes",
                &self.bytes.iter().map(|(path, _)| path).collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn byte_arrays_are_found_where_they_were() {
        let output = CallOutput::new(
            json!({ "name": "a", "image": null }),
            vec![(vec!["image".into()], Bytes::from_static(b"png"))],
        );
        assert_eq!(output.bytes_at("/image").unwrap(), &b"png"[..]);
        assert!(output.bytes_at("/name").is_none());
        assert!(output.bytes_at("image").is_none());
        #[derive(serde::Deserialize)]
        struct Thumbnail {
            name: String,
            image: Vec<u8>,
        }
        let thumbnail: Thumbnail = output.deserialize().unwrap();
        assert_eq!(
            (thumbnail.name.as_str(), thumbnail.image.as_slice()),
            ("a", &b"png"[..])
        );
        assert!(matches!(
            output.deserialize::<u8>(),
            Err(Error::JavaScript(_))
        ));
    }
}

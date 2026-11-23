//! The byte arrays JavaScript sends beside a JSON value: one buffer in the
//! byte store, cut into parts in order, each for the path where it goes.

use bytes::Bytes;
use serde::Deserialize;
use serde_json::Value;

use super::{Placed, clear, invalid, overlaps};
use crate::Result;

/// Where the parts of one buffer go in a JSON value.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ByteLayout {
    handle: u64,
    parts: Vec<BytePart>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BytePart {
    path: Vec<String>,
    length: usize,
}

impl ByteLayout {
    /// The byte store handle of the buffer.
    pub fn handle(&self) -> u64 {
        self.handle
    }

    /// Cut `buffer` into its parts, checked against `value`: each at a
    /// distinct value, which becomes `null`, and together
    /// filling the buffer. `whole` allows the empty path, for a value that
    /// is itself a byte array.
    pub fn split(self, value: &mut Value, buffer: Bytes, whole: bool) -> Result<Placed<Bytes>> {
        let mut placed: Placed<Bytes> = Vec::with_capacity(self.parts.len());
        let mut offset = 0usize;
        for BytePart { path, length } in self.parts {
            let end = offset
                .checked_add(length)
                .filter(|end| *end <= buffer.len())
                .ok_or_else(|| invalid("byte parts exceed their buffer"))?;
            if (path.is_empty() && !whole)
                || overlaps(placed.iter().map(|(path, _)| path.as_slice()), &path)
                || !clear(value, &path)
            {
                return Err(invalid("a byte part needs its own value"));
            }
            placed.push((path, buffer.slice(offset..end)));
            offset = end;
        }
        if offset != buffer.len() {
            return Err(invalid("byte parts do not fill their buffer"));
        }
        Ok(placed)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn part(path: &[&str], length: usize) -> BytePart {
        BytePart {
            path: path.iter().map(|token| (*token).to_owned()).collect(),
            length,
        }
    }

    fn split(parts: Vec<BytePart>, whole: bool) -> Result<Placed<Bytes>> {
        let mut value = json!([null, { "a": null }]);
        ByteLayout { handle: 0, parts }.split(&mut value, Bytes::from_static(b"abc"), whole)
    }

    #[test]
    fn parts_fill_distinct_values() {
        let placed = split(vec![part(&["0"], 1), part(&["1", "a"], 2)], false).unwrap();
        assert_eq!(
            placed[1],
            (vec!["1".into(), "a".into()], Bytes::from_static(b"bc"))
        );
        for parts in [
            vec![part(&["0"], 1)],
            vec![part(&["0"], 4)],
            vec![part(&["0"], 1), part(&["0"], 2)],
            vec![part(&["1"], 1), part(&["1", "a"], 2)],
            vec![part(&[], 3)],
            vec![part(&["2"], 3)],
        ] {
            assert!(split(parts, false).is_err());
        }
    }

    #[test]
    fn the_whole_value_needs_permission() {
        assert_eq!(
            split(vec![part(&[], 3)], true).unwrap()[0].0,
            Vec::<String>::new()
        );
        assert!(split(vec![part(&[], 2), part(&["0"], 1)], true).is_err());
    }
}

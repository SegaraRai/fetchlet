//! JSON Pointers (RFC 6901) that place resources, such as channels and
//! byte arrays, into JSON values without reserving a JSON shape for them.

use serde_json::Value;

use crate::{Error, Result};

/// Resources, each by the path of reference tokens where it goes.
pub(crate) type Placed<T> = Vec<(Vec<String>, T)>;

/// The reference tokens of a JSON Pointer.
pub(crate) fn parse(pointer: &str) -> Result<Vec<String>> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let Some(tokens) = pointer.strip_prefix('/') else {
        return Err(invalid("a JSON Pointer starts with /"));
    };
    Ok(tokens
        .split('/')
        .map(|token| token.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// Whether `path` is inside, around or at one of `taken`.
pub(crate) fn overlaps<'a>(taken: impl IntoIterator<Item = &'a [String]>, path: &[String]) -> bool {
    taken.into_iter().any(|other| {
        let shorter = other.len().min(path.len());
        other[..shorter] == path[..shorter]
    })
}

/// Replace the value at `path` in `root` with `null`, returning whether it
/// named a value. The empty path names `root` itself.
pub(crate) fn clear(root: &mut Value, path: &[String]) -> bool {
    let mut value = root;
    for token in path {
        value = match value {
            Value::Object(map) => match map.get_mut(token) {
                Some(value) => value,
                None => return false,
            },
            Value::Array(list) => match index(token).and_then(|index| list.get_mut(index)) {
                Some(value) => value,
                None => return false,
            },
            _ => return false,
        };
    }
    *value = Value::Null;
    true
}

/// An array index token: decimal digits without a leading zero.
fn index(token: &str) -> Option<usize> {
    if token.is_empty()
        || (token.len() > 1 && token.starts_with('0'))
        || !token.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    token.parse().ok()
}

pub(crate) fn invalid(message: &str) -> Error {
    Error::InvalidRequest(message.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn pointers_parse_and_clear_values() {
        assert_eq!(parse("").unwrap(), Vec::<String>::new());
        assert_eq!(parse("/a~1b/~0c/0").unwrap(), vec!["a/b", "~c", "0"]);
        assert!(parse("a").is_err());

        let mut value = json!({ "a/b": [1, 2], "c": { "d": 3 } });
        assert!(clear(&mut value, &parse("/a~1b/1").unwrap()));
        assert!(!clear(&mut value, &parse("/a~1b/01").unwrap()));
        assert!(!clear(&mut value, &parse("/a~1b/2").unwrap()));
        assert!(!clear(&mut value, &parse("/c/missing").unwrap()));
        assert_eq!(value, json!({ "a/b": [1, null], "c": { "d": 3 } }));
        assert!(clear(&mut value, &[]));
        assert_eq!(value, Value::Null);
    }

    #[test]
    fn overlapping_paths_are_detected() {
        let taken = [vec!["0".to_owned(), "a".to_owned()]];
        let taken = taken.iter().map(Vec::as_slice);
        for (path, overlapping) in [
            (vec!["0"], true),
            (vec!["0", "a"], true),
            (vec!["0", "a", "b"], true),
            (vec!["0", "b"], false),
            (vec!["1"], false),
        ] {
            let path: Vec<String> = path.into_iter().map(str::to_owned).collect();
            assert_eq!(overlaps(taken.clone(), &path), overlapping, "{path:?}");
        }
    }
}

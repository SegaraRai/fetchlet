//! Deserialization of function arguments whose JSON carries byte arrays
//! beside it: each byte array is read where JavaScript passed it, as bytes,
//! and everything else as the JSON value it is.

use bytes::Bytes;
use serde::de::value::{BorrowedStrDeserializer, SeqDeserializer};
use serde::de::{
    self, DeserializeOwned, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor,
};
use serde_json::{Error, Value};

/// `args` as `T`, with the byte arrays of `bytes` at their paths.
pub(super) fn deserialize<T: DeserializeOwned>(
    args: &Value,
    bytes: &[(Vec<String>, Bytes)],
) -> Result<T, Error> {
    if bytes.is_empty() {
        return T::deserialize(args);
    }
    let places: Vec<Place<'_>> = bytes
        .iter()
        .map(|(path, bytes)| (path.as_slice(), bytes))
        .collect();
    T::deserialize(Node::new(args, &places))
}

/// A byte array, by the rest of its path below the current node.
type Place<'a> = (&'a [String], &'a Bytes);

/// The arguments as a tree: containers on the way to a byte array are
/// expanded, and every other value stays its JSON.
enum Node<'a> {
    Json(&'a Value),
    Bytes(&'a Bytes),
    Seq(Vec<Node<'a>>),
    Map(Vec<(&'a str, Node<'a>)>),
}

impl<'a> Node<'a> {
    fn new(value: &'a Value, places: &[Place<'a>]) -> Self {
        if let Some((_, bytes)) = places.iter().find(|(path, _)| path.is_empty()) {
            return Node::Bytes(bytes);
        }
        if places.is_empty() {
            return Node::Json(value);
        }
        let below = |token: &str| -> Vec<Place<'a>> {
            places
                .iter()
                .filter(|(path, _)| path[0] == token)
                .map(|(path, bytes)| (&path[1..], *bytes))
                .collect()
        };
        match value {
            Value::Array(items) => Node::Seq(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| Node::new(item, &below(&index.to_string())))
                    .collect(),
            ),
            Value::Object(map) => Node::Map(
                map.iter()
                    .map(|(key, value)| (key.as_str(), Node::new(value, &below(key))))
                    .collect(),
            ),
            // The bridge placed every byte array at a value of the JSON.
            _ => Node::Json(value),
        }
    }

    fn visit_bytes_seq<V: Visitor<'a>>(bytes: &'a Bytes, visitor: V) -> Result<V::Value, Error> {
        let mut seq = SeqDeserializer::new(bytes.iter().copied());
        let value = visitor.visit_seq(&mut seq)?;
        seq.end()?;
        Ok(value)
    }
}

/// Forward a method to the JSON of a JSON node, and to `deserialize_any`
/// for the others.
macro_rules! forward_json {
    ($($method:ident)*) => {
        $(
            fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
                match self {
                    Node::Json(value) => value.$method(visitor),
                    node => node.deserialize_any(visitor),
                }
            }
        )*
    };
}

impl<'de> Deserializer<'de> for Node<'de> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_any(visitor),
            Node::Bytes(bytes) => visitor.visit_borrowed_bytes(bytes),
            Node::Seq(items) => visit_items(items, visitor),
            Node::Map(entries) => visitor.visit_map(Entries {
                entries: entries.into_iter(),
                value: None,
            }),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_option(visitor),
            node => visitor.visit_some(node),
        }
    }

    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_bytes(visitor),
            node => node.deserialize_any(visitor),
        }
    }

    fn deserialize_byte_buf<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_byte_buf(visitor),
            node => node.deserialize_any(visitor),
        }
    }

    /// A byte array read as a sequence, such as `Vec<u8>`, is a sequence of
    /// its bytes.
    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_seq(visitor),
            Node::Bytes(bytes) => Node::visit_bytes_seq(bytes, visitor),
            node => node.deserialize_any(visitor),
        }
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_tuple(len, visitor),
            node => node.deserialize_seq(visitor),
        }
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_tuple_struct(name, len, visitor),
            node => node.deserialize_seq(visitor),
        }
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_struct(name, fields, visitor),
            node => node.deserialize_any(visitor),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_newtype_struct(name, visitor),
            node => visitor.visit_newtype_struct(node),
        }
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_unit_struct(name, visitor),
            node => node.deserialize_any(visitor),
        }
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Node::Json(value) => value.deserialize_enum(name, variants, visitor),
            _ => Err(de::Error::custom("an enum cannot hold a byte array")),
        }
    }

    forward_json! {
        deserialize_bool deserialize_i8 deserialize_i16 deserialize_i32 deserialize_i64
        deserialize_i128 deserialize_u8 deserialize_u16 deserialize_u32 deserialize_u64
        deserialize_u128 deserialize_f32 deserialize_f64 deserialize_char deserialize_str
        deserialize_string deserialize_unit deserialize_map deserialize_identifier
        deserialize_ignored_any
    }
}

/// Visit `items` as a sequence that the visitor must read to the end, as
/// serde_json requires of an array.
fn visit_items<'de, V: Visitor<'de>>(items: Vec<Node<'de>>, visitor: V) -> Result<V::Value, Error> {
    let len = items.len();
    let mut items = Items(items.into_iter());
    let value = visitor.visit_seq(&mut items)?;
    if items.0.len() == 0 {
        Ok(value)
    } else {
        Err(de::Error::invalid_length(len, &"fewer elements in array"))
    }
}

struct Items<'de>(std::vec::IntoIter<Node<'de>>);

impl<'de> SeqAccess<'de> for Items<'de> {
    type Error = Error;

    fn next_element_seed<T: DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Error> {
        self.0.next().map(|node| seed.deserialize(node)).transpose()
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.0.len())
    }
}

struct Entries<'de> {
    entries: std::vec::IntoIter<(&'de str, Node<'de>)>,
    value: Option<Node<'de>>,
}

impl<'de> MapAccess<'de> for Entries<'de> {
    type Error = Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Error> {
        match self.entries.next() {
            Some((key, value)) => {
                self.value = Some(value);
                seed.deserialize(BorrowedStrDeserializer::new(key))
                    .map(Some)
            }
            None => Ok(None),
        }
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        let value = self
            .value
            .take()
            .ok_or_else(|| de::Error::custom("a map value without its key"))?;
        seed.deserialize(value)
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.entries.len())
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    fn path(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|token| (*token).to_owned()).collect()
    }

    #[derive(Deserialize, Debug, PartialEq)]
    struct Upload {
        name: String,
        data: Vec<u8>,
        tag: Option<Vec<u8>>,
    }

    #[test]
    fn byte_arrays_deserialize_where_they_were_passed() {
        let args = json!(["key", { "name": "a", "data": null, "tag": null }, [1, null]]);
        let bytes = vec![
            (path(&["1", "data"]), Bytes::from_static(b"\x00\xff")),
            (path(&["1", "tag"]), Bytes::from_static(b"t")),
            (path(&["2", "1"]), Bytes::from_static(b"xy")),
        ];
        let (key, upload, list): (String, Upload, (u8, Vec<u8>)) =
            deserialize(&args, &bytes).unwrap();
        assert_eq!(key, "key");
        assert_eq!(
            upload,
            Upload {
                name: "a".into(),
                data: vec![0, 255],
                tag: Some(b"t".to_vec()),
            }
        );
        assert_eq!(list, (1, b"xy".to_vec()));
        // As JSON, a byte array is the null that holds its place.
        let raw: Vec<Value> = deserialize(&args, &[]).unwrap();
        assert_eq!(raw[1]["data"], Value::Null);
    }

    #[test]
    fn counts_and_types_still_apply() {
        let args = json!([null, 1]);
        let bytes = vec![(path(&["0"]), Bytes::from_static(b"a"))];
        assert!(deserialize::<(Vec<u8>,)>(&args, &bytes).is_err());
        assert!(deserialize::<(Vec<u8>, u8, u8)>(&args, &bytes).is_err());
        assert!(deserialize::<(u32, u8)>(&args, &bytes).is_err());
        assert!(deserialize::<(Vec<u8>, u8)>(&args, &bytes).is_ok());
    }
}

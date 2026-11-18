//! `CompressionStream` and `DecompressionStream`: the codecs open in an
//! invocation and the operations the guest drives them with.

mod codec;
mod operations;

pub(crate) use operations::{Codecs, dispatch};

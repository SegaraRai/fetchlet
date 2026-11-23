//! `CompressionStream` and `DecompressionStream`: the codecs open in an
//! invocation and the operations the guest drives them with, and the
//! decompressor for host code.

mod codec;
mod decompressor;
mod operations;

pub use decompressor::{CompressionFormat, Decompressor};

pub(crate) use operations::{Codecs, dispatch};

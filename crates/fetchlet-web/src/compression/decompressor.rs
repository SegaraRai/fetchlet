use super::codec::{Codec, Format};
use crate::Result;

/// A compression format of [`Decompressor`], as the Compression Standard
/// names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompressionFormat {
    /// zlib (RFC 1950), the HTTP `deflate` coding.
    Deflate,
    /// Raw deflate (RFC 1951), which some servers send as `deflate`.
    DeflateRaw,
    /// gzip (RFC 1952).
    Gzip,
    /// Brotli (RFC 7932).
    Brotli,
}

/// The streaming decompressor of `DecompressionStream`, for host code such
/// as an HTTP client that decodes a `Content-Encoding`.
///
/// Write input, then read output until [`read`](Self::read) returns `None`
/// before writing again; after [`finish`](Self::finish), reads return the
/// rest and fail if the compressed stream ended early. Each read returns at
/// most 64 KiB, so a small input never inflates into one large buffer, and
/// the decompressed bytes in all count toward `limit`, failing with
/// `LimitExceeded` past it. Data after the end of the stream, invalid data
/// and a gzip checksum that does not match fail with `InvalidRequest`.
pub struct Decompressor(Codec);

impl Decompressor {
    pub fn new(format: CompressionFormat, limit: Option<usize>) -> Self {
        let format = match format {
            CompressionFormat::Deflate => Format::Deflate,
            CompressionFormat::DeflateRaw => Format::DeflateRaw,
            CompressionFormat::Gzip => Format::Gzip,
            CompressionFormat::Brotli => Format::Brotli,
        };
        Self(Codec::decompressor(format, limit))
    }

    /// Add compressed input. Fails while output of the previous write is
    /// still to be read.
    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.0.write(bytes)
    }

    /// Mark the end of the compressed input.
    pub fn finish(&mut self) {
        self.0.finish();
    }

    /// The next piece of output, or `None` until more input arrives, or,
    /// after [`finish`](Self::finish), once the stream is complete.
    pub fn read(&mut self) -> Result<Option<Vec<u8>>> {
        self.0.read()
    }
}

impl std::fmt::Debug for Decompressor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Decompressor")
            .finish_non_exhaustive()
    }
}

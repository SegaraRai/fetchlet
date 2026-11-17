//! Codecs for the guest's `CompressionStream` and `DecompressionStream`
//! (Compression Standard, https://compression.spec.whatwg.org/): "deflate"
//! (zlib, RFC 1950), "deflate-raw" (RFC 1951), "gzip" (RFC 1952) and
//! "brotli" (RFC 7932).
//!
//! The guest writes input and then reads output in pieces of at most
//! [`OUTPUT_PIECE`] bytes, so one small input never has to inflate into one
//! large message. Decompressed output counts toward
//! [`Limits::decompressed_bytes`](crate::Limits::decompressed_bytes).

use brotli::enc::StandardAlloc;
use brotli::enc::encode::{
    BrotliEncoderOperation, BrotliEncoderParameter, BrotliEncoderStateStruct,
};
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};
use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};

use crate::{Error, Result};

/// The largest piece one read returns. It sets the transfer granularity of
/// the byte store, not a budget: a stream's output is unbounded except by
/// the decompressed-bytes limit.
pub(super) const OUTPUT_PIECE: usize = 64 * 1024;

/// zlib's default level, which browsers use for deflate and gzip.
const DEFLATE_LEVEL: u32 = 6;
/// A middle brotli quality: quality 11, brotli's default, is meant for
/// static assets and is too slow for streaming responses.
const BROTLI_QUALITY: u32 = 6;
/// brotli's default window of 4 MiB.
const BROTLI_WINDOW_BITS: u32 = 22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Format {
    Deflate,
    DeflateRaw,
    Gzip,
    Brotli,
}

impl Format {
    pub(super) fn parse(name: &str) -> Option<Self> {
        match name {
            "deflate" => Some(Self::Deflate),
            "deflate-raw" => Some(Self::DeflateRaw),
            "gzip" => Some(Self::Gzip),
            "brotli" => Some(Self::Brotli),
            _ => None,
        }
    }
}

/// One stream's codec, its unconsumed input and its staged output.
pub(super) struct Codec {
    engine: Engine,
    input: Vec<u8>,
    consumed: usize,
    output: Vec<u8>,
    finishing: bool,
    done: bool,
    /// Decompressed bytes produced so far, and the budget for them.
    produced: usize,
    limit: Option<usize>,
    /// A failure found after output that is still to be read; it is
    /// reported by the next read, as a stream errors after its last chunk.
    failure: Option<Error>,
}

enum Engine {
    Deflate {
        stream: Compress,
        /// The gzip header still to emit and the running checksum, for gzip.
        gzip: Option<(Option<[u8; 10]>, Crc)>,
    },
    Inflate {
        stream: Decompress,
        gzip: Option<GzipInput>,
        ended: bool,
    },
    BrotliEncode(Box<BrotliEncoderStateStruct<StandardAlloc>>),
    BrotliDecode(Box<BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>>),
}

/// The framing of a gzip member around its deflate data.
struct GzipInput {
    header_read: bool,
    crc: Crc,
}

impl Codec {
    pub(super) fn compressor(format: Format) -> Self {
        let engine = match format {
            Format::Brotli => {
                let mut state = BrotliEncoderStateStruct::new(StandardAlloc::default());
                state.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_QUALITY, BROTLI_QUALITY);
                state.set_parameter(
                    BrotliEncoderParameter::BROTLI_PARAM_LGWIN,
                    BROTLI_WINDOW_BITS,
                );
                Engine::BrotliEncode(Box::new(state))
            }
            Format::Deflate | Format::DeflateRaw | Format::Gzip => Engine::Deflate {
                stream: Compress::new(Compression::new(DEFLATE_LEVEL), format == Format::Deflate),
                // Deflate method, no flags, no time, no extra flags, unknown OS.
                gzip: (format == Format::Gzip)
                    .then(|| (Some([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]), Crc::new())),
            },
        };
        Self::new(engine, None)
    }

    pub(super) fn decompressor(format: Format, limit: Option<usize>) -> Self {
        let engine = match format {
            Format::Brotli => Engine::BrotliDecode(Box::new(BrotliState::new(
                StandardAlloc::default(),
                StandardAlloc::default(),
                StandardAlloc::default(),
            ))),
            Format::Deflate | Format::DeflateRaw | Format::Gzip => Engine::Inflate {
                stream: Decompress::new(format == Format::Deflate),
                gzip: (format == Format::Gzip).then(|| GzipInput {
                    header_read: false,
                    crc: Crc::new(),
                }),
                ended: false,
            },
        };
        Self::new(engine, limit)
    }

    fn new(engine: Engine, limit: Option<usize>) -> Self {
        Self {
            engine,
            input: Vec::new(),
            consumed: 0,
            output: Vec::new(),
            finishing: false,
            done: false,
            produced: 0,
            limit,
            failure: None,
        }
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if self.finishing {
            return Err(invalid("write after close"));
        }
        if self.done
            && matches!(
                self.engine,
                Engine::Inflate { .. } | Engine::BrotliDecode(_)
            )
        {
            if bytes.is_empty() {
                return Ok(());
            }
            return Err(invalid("data after the end of the compressed stream"));
        }
        self.input.drain(..self.consumed);
        self.consumed = 0;
        self.input.extend_from_slice(bytes);
        Ok(())
    }

    /// Mark the end of input; the remaining output follows from `read`.
    pub(super) fn finish(&mut self) {
        self.finishing = true;
    }

    /// The next piece of output, or None until more input arrives (or, after
    /// `finish`, once the stream is complete).
    pub(super) fn read(&mut self) -> Result<Option<Vec<u8>>> {
        if self.output.is_empty()
            && let Some(failure) = self.failure.take()
        {
            return Err(failure);
        }
        while self.output.len() < OUTPUT_PIECE && self.failure.is_none() {
            match self.step() {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) if self.output.is_empty() => return Err(error),
                Err(error) => self.failure = Some(error),
            }
        }
        if self.output.is_empty() {
            return Ok(None);
        }
        let take = self.output.len().min(OUTPUT_PIECE);
        Ok(Some(self.output.drain(..take).collect()))
    }

    fn pending(&self) -> &[u8] {
        &self.input[self.consumed..]
    }

    /// Run the engine once; false when it cannot progress now.
    fn step(&mut self) -> Result<bool> {
        if self.done {
            if !self.pending().is_empty() {
                return Err(invalid("data after the end of the compressed stream"));
            }
            return Ok(false);
        }
        let decompressing = matches!(
            self.engine,
            Engine::Inflate { .. } | Engine::BrotliDecode(_)
        );
        let before = self.output.len();
        let progressed = match self.engine {
            Engine::Deflate { .. } => self.deflate_step()?,
            Engine::Inflate { .. } => self.inflate_step()?,
            Engine::BrotliEncode(_) => self.brotli_encode_step()?,
            Engine::BrotliDecode(_) => self.brotli_decode_step()?,
        };
        if decompressing {
            self.produced += self.output.len() - before;
            if self.limit.is_some_and(|limit| self.produced > limit) {
                return Err(Error::LimitExceeded("decompressed bytes"));
            }
            if !progressed && self.finishing && !self.done {
                return Err(invalid("the compressed stream ended early"));
            }
        }
        Ok(progressed)
    }

    fn deflate_step(&mut self) -> Result<bool> {
        let Engine::Deflate { stream, gzip } = &mut self.engine else {
            unreachable!()
        };
        if let Some((header @ Some(_), _)) = gzip {
            self.output
                .extend_from_slice(&header.take().unwrap_or_default());
            return Ok(true);
        }
        if self.input.len() == self.consumed && !self.finishing {
            return Ok(false);
        }
        let input = &self.input[self.consumed..];
        let mut buffer = [0u8; 16 * 1024];
        let (in_before, out_before) = (stream.total_in(), stream.total_out());
        let flush = if self.finishing {
            FlushCompress::Finish
        } else {
            FlushCompress::None
        };
        let status = stream
            .compress(input, &mut buffer, flush)
            .map_err(|_| invalid("compression failed"))?;
        let read = (stream.total_in() - in_before) as usize;
        let written = (stream.total_out() - out_before) as usize;
        if let Some((_, crc)) = gzip {
            crc.update(&input[..read]);
        }
        self.consumed += read;
        self.output.extend_from_slice(&buffer[..written]);
        if status == Status::StreamEnd {
            if let Some((_, crc)) = gzip {
                self.output.extend_from_slice(&crc.sum().to_le_bytes());
                self.output.extend_from_slice(&crc.amount().to_le_bytes());
            }
            self.done = true;
        }
        Ok(read > 0 || written > 0 || self.done)
    }

    fn inflate_step(&mut self) -> Result<bool> {
        let Engine::Inflate {
            stream,
            gzip,
            ended,
        } = &mut self.engine
        else {
            unreachable!()
        };
        let input = &self.input[self.consumed..];
        if let Some(framing) = gzip.as_mut().filter(|framing| !framing.header_read) {
            let Some(length) = gzip_header_length(input)? else {
                return Ok(false);
            };
            framing.header_read = true;
            self.consumed += length;
            return Ok(true);
        }
        if *ended {
            // The gzip trailer: CRC-32 and size modulo 2^32, little-endian.
            let Some(framing) = gzip else {
                self.done = true;
                return Ok(true);
            };
            if input.len() < 8 {
                return Ok(false);
            }
            let crc = u32::from_le_bytes(input[..4].try_into().unwrap_or_default());
            let size = u32::from_le_bytes(input[4..8].try_into().unwrap_or_default());
            if crc != framing.crc.sum() || size != framing.crc.amount() {
                return Err(invalid("the gzip checksum does not match"));
            }
            self.consumed += 8;
            self.done = true;
            return Ok(true);
        }
        let mut buffer = [0u8; 16 * 1024];
        let (in_before, out_before) = (stream.total_in(), stream.total_out());
        let status = stream
            .decompress(input, &mut buffer, FlushDecompress::None)
            .map_err(|_| invalid("the compressed data is invalid"))?;
        let read = (stream.total_in() - in_before) as usize;
        let written = (stream.total_out() - out_before) as usize;
        if let Some(framing) = gzip {
            framing.crc.update(&buffer[..written]);
        }
        self.consumed += read;
        self.output.extend_from_slice(&buffer[..written]);
        if status == Status::StreamEnd {
            *ended = true;
            return Ok(true);
        }
        Ok(read > 0 || written > 0)
    }

    fn brotli_encode_step(&mut self) -> Result<bool> {
        let Engine::BrotliEncode(state) = &mut self.engine else {
            unreachable!()
        };
        if self.input.len() == self.consumed && !self.finishing {
            return Ok(false);
        }
        let operation = if self.finishing {
            BrotliEncoderOperation::BROTLI_OPERATION_FINISH
        } else {
            BrotliEncoderOperation::BROTLI_OPERATION_PROCESS
        };
        let mut buffer = [0u8; 16 * 1024];
        let mut available_in = self.input.len() - self.consumed;
        let mut input_offset = self.consumed;
        let mut available_out = buffer.len();
        let mut output_offset = 0;
        let mut total_out = None;
        let ok = state.compress_stream(
            operation,
            &mut available_in,
            &self.input,
            &mut input_offset,
            &mut available_out,
            &mut buffer,
            &mut output_offset,
            &mut total_out,
            &mut |_, _, _, _| (),
        );
        if !ok {
            return Err(invalid("compression failed"));
        }
        let read = input_offset - self.consumed;
        self.consumed = input_offset;
        self.output.extend_from_slice(&buffer[..output_offset]);
        if self.finishing && state.is_finished() {
            self.done = true;
        }
        Ok(read > 0 || output_offset > 0 || self.done)
    }

    fn brotli_decode_step(&mut self) -> Result<bool> {
        let Engine::BrotliDecode(state) = &mut self.engine else {
            unreachable!()
        };
        let mut buffer = [0u8; 16 * 1024];
        let mut available_in = self.input.len() - self.consumed;
        let mut input_offset = self.consumed;
        let mut available_out = buffer.len();
        let mut output_offset = 0;
        let mut total_out = 0;
        let result = BrotliDecompressStream(
            &mut available_in,
            &mut input_offset,
            &self.input,
            &mut available_out,
            &mut output_offset,
            &mut buffer,
            &mut total_out,
            state,
        );
        let read = input_offset - self.consumed;
        self.consumed = input_offset;
        self.output.extend_from_slice(&buffer[..output_offset]);
        match result {
            BrotliResult::ResultFailure => Err(invalid("the compressed data is invalid")),
            BrotliResult::ResultSuccess => {
                self.done = true;
                Ok(true)
            }
            BrotliResult::NeedsMoreOutput => Ok(true),
            BrotliResult::NeedsMoreInput => Ok(read > 0 || output_offset > 0),
        }
    }
}

/// The length of a complete gzip member header (RFC 1952 §2.3), None while
/// it is incomplete.
fn gzip_header_length(input: &[u8]) -> Result<Option<usize>> {
    const FHCRC: u8 = 2;
    const FEXTRA: u8 = 4;
    const FNAME: u8 = 8;
    const FCOMMENT: u8 = 16;
    if input.len() < 10 {
        return Ok(None);
    }
    if input[0] != 0x1f || input[1] != 0x8b || input[2] != 8 || input[3] & 0xe0 != 0 {
        return Err(invalid("the gzip header is invalid"));
    }
    let flags = input[3];
    let mut length = 10;
    if flags & FEXTRA != 0 {
        let Some(size) = input.get(length..length + 2) else {
            return Ok(None);
        };
        length += 2 + u16::from_le_bytes([size[0], size[1]]) as usize;
    }
    for flag in [FNAME, FCOMMENT] {
        if flags & flag != 0 {
            let Some(end) = input
                .get(length..)
                .and_then(|rest| rest.iter().position(|&byte| byte == 0))
            else {
                return Ok(None);
            };
            length += end + 1;
        }
    }
    if flags & FHCRC != 0 {
        length += 2;
    }
    Ok((input.len() >= length).then_some(length))
}

fn invalid(message: &str) -> Error {
    Error::InvalidRequest(message.into())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn run(codec: &mut Codec, chunks: &[&[u8]]) -> Result<Vec<u8>> {
        let mut output = Vec::new();
        for chunk in chunks {
            codec.write(chunk)?;
            while let Some(piece) = codec.read()? {
                assert!(piece.len() <= OUTPUT_PIECE);
                output.extend(piece);
            }
        }
        codec.finish();
        while let Some(piece) = codec.read()? {
            output.extend(piece);
        }
        Ok(output)
    }

    fn sample() -> Vec<u8> {
        (0..200_000u32)
            .flat_map(|n| (n % 251).to_le_bytes())
            .collect()
    }

    #[test]
    fn every_format_round_trips_across_split_chunks() {
        let data = sample();
        for format in [
            Format::Deflate,
            Format::DeflateRaw,
            Format::Gzip,
            Format::Brotli,
        ] {
            let compressed = run(
                &mut Codec::compressor(format),
                &[&data[..1000], &data[1000..]],
            )
            .unwrap();
            let pieces: Vec<&[u8]> = compressed.chunks(7).collect();
            let restored = run(&mut Codec::decompressor(format, None), &pieces).unwrap();
            assert_eq!(restored, data, "{format:?}");
        }
    }

    #[test]
    fn gzip_matches_other_implementations() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"fetchlet").unwrap();
        let theirs = encoder.finish().unwrap();
        let restored = run(&mut Codec::decompressor(Format::Gzip, None), &[&theirs]).unwrap();
        assert_eq!(restored, b"fetchlet");
        let ours = run(&mut Codec::compressor(Format::Gzip), &[b"fetchlet"]).unwrap();
        let mut decoder = flate2::read::GzDecoder::new(&ours[..]);
        let mut text = String::new();
        std::io::Read::read_to_string(&mut decoder, &mut text).unwrap();
        assert_eq!(text, "fetchlet");
    }

    #[test]
    fn invalid_truncated_and_trailing_input_fail() {
        for format in [
            Format::Deflate,
            Format::DeflateRaw,
            Format::Gzip,
            Format::Brotli,
        ] {
            let compressed = run(&mut Codec::compressor(format), &[b"hello"]).unwrap();
            let truncated = &compressed[..compressed.len() - 1];
            assert!(
                run(&mut Codec::decompressor(format, None), &[truncated]).is_err(),
                "{format:?}"
            );
            let mut padded = compressed.clone();
            padded.push(0);
            assert!(
                run(&mut Codec::decompressor(format, None), &[&padded]).is_err(),
                "{format:?}"
            );
        }
        assert!(
            run(
                &mut Codec::decompressor(Format::Gzip, None),
                &[b"not gzip at all"]
            )
            .is_err()
        );
    }

    #[test]
    fn decompressed_bytes_are_bounded() {
        let zeros = vec![0u8; 1 << 20];
        let compressed = run(&mut Codec::compressor(Format::Deflate), &[&zeros]).unwrap();
        let error = run(
            &mut Codec::decompressor(Format::Deflate, Some(1000)),
            &[&compressed],
        )
        .unwrap_err();
        assert!(matches!(error, Error::LimitExceeded("decompressed bytes")));
    }
}

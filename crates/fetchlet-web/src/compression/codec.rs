//! Codecs for the guest's `CompressionStream` and `DecompressionStream`
//! (Compression Standard, https://compression.spec.whatwg.org/): "deflate"
//! (zlib, RFC 1950), "deflate-raw" (RFC 1951), "gzip" (RFC 1952) and
//! "brotli" (RFC 7932).
//!
//! The guest writes input and then reads output in pieces of at most
//! [`OUTPUT_PIECE`] bytes, so one small input never has to inflate into one
//! large message. Decompressed output counts toward
//! [`WebLimits::decompressed_bytes`](crate::WebLimits::decompressed_bytes).
//!
//! The codec holds at most one write of input that is still to be processed:
//! a write is refused until reads have drained the previous one, and a gzip
//! header is consumed as it arrives. So the host keeps no more of the guest's
//! bytes than one bridge message, plus a few bytes of incomplete framing.

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
    /// Whether input was written since a read last returned None.
    undrained: bool,
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
    header: GzipHeader,
    crc: Crc,
}

/// A gzip member header (RFC 1952, section 2.3), consumed as it arrives so
/// that a long file name or comment is never buffered.
struct GzipHeader {
    flags: u8,
    stage: HeaderStage,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HeaderStage {
    Fixed,
    ExtraLength,
    Extra(usize),
    Name,
    Comment,
    Checksum,
    Done,
}

impl GzipHeader {
    const FHCRC: u8 = 2;
    const FEXTRA: u8 = 4;
    const FNAME: u8 = 8;
    const FCOMMENT: u8 = 16;

    fn new() -> Self {
        Self {
            flags: 0,
            stage: HeaderStage::Fixed,
        }
    }

    fn is_done(&self) -> bool {
        self.stage == HeaderStage::Done
    }

    /// The first stage from `stage` on that the flags call for.
    fn present(&self, stage: HeaderStage) -> HeaderStage {
        let wanted = |flag: u8| self.flags & flag != 0;
        match stage {
            HeaderStage::ExtraLength if !wanted(Self::FEXTRA) => self.present(HeaderStage::Name),
            HeaderStage::Name if !wanted(Self::FNAME) => self.present(HeaderStage::Comment),
            HeaderStage::Comment if !wanted(Self::FCOMMENT) => self.present(HeaderStage::Checksum),
            HeaderStage::Checksum if !wanted(Self::FHCRC) => HeaderStage::Done,
            stage => stage,
        }
    }

    /// Consume header bytes from `input`; returns how many it used.
    fn consume(&mut self, input: &[u8]) -> Result<usize> {
        let mut used = 0;
        loop {
            let rest = &input[used..];
            match self.stage {
                HeaderStage::Fixed => {
                    let Some(fixed) = rest.get(..10) else {
                        return Ok(used);
                    };
                    if fixed[0] != 0x1f || fixed[1] != 0x8b || fixed[2] != 8 || fixed[3] & 0xe0 != 0
                    {
                        return Err(invalid("the gzip header is invalid"));
                    }
                    self.flags = fixed[3];
                    used += 10;
                    self.stage = self.present(HeaderStage::ExtraLength);
                }
                HeaderStage::ExtraLength => {
                    let Some(size) = rest.get(..2) else {
                        return Ok(used);
                    };
                    used += 2;
                    let size = usize::from(u16::from_le_bytes([size[0], size[1]]));
                    self.stage = HeaderStage::Extra(size);
                }
                HeaderStage::Extra(remaining) => {
                    let skipped = remaining.min(rest.len());
                    used += skipped;
                    if skipped < remaining {
                        self.stage = HeaderStage::Extra(remaining - skipped);
                        return Ok(used);
                    }
                    self.stage = self.present(HeaderStage::Name);
                }
                HeaderStage::Name | HeaderStage::Comment => {
                    let Some(end) = rest.iter().position(|&byte| byte == 0) else {
                        return Ok(used + rest.len());
                    };
                    used += end + 1;
                    self.stage = if self.stage == HeaderStage::Name {
                        self.present(HeaderStage::Comment)
                    } else {
                        self.present(HeaderStage::Checksum)
                    };
                }
                HeaderStage::Checksum => {
                    if rest.len() < 2 {
                        return Ok(used);
                    }
                    used += 2;
                    self.stage = HeaderStage::Done;
                }
                HeaderStage::Done => return Ok(used),
            }
        }
    }
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
                    header: GzipHeader::new(),
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
            undrained: false,
            produced: 0,
            limit,
            failure: None,
        }
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if self.finishing {
            return Err(invalid("write after close"));
        }
        if self.undrained {
            return Err(invalid("the previous input has not been read"));
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
        self.undrained = !bytes.is_empty();
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
            self.undrained = false;
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
        if let Some(framing) = gzip.as_mut().filter(|framing| !framing.header.is_done()) {
            let used = framing.header.consume(input)?;
            self.consumed += used;
            return Ok(used > 0);
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

    #[test]
    fn a_write_waits_for_reads_to_drain_the_previous_one() {
        let mut codec = Codec::compressor(Format::Gzip);
        codec.write(b"first").unwrap();
        assert!(matches!(
            codec.write(b"second"),
            Err(Error::InvalidRequest(_))
        ));
        while codec.read().unwrap().is_some() {}
        codec.write(b"second").unwrap();
    }

    #[test]
    fn a_long_gzip_header_is_consumed_as_it_arrives() {
        // A file name of 1 MiB arrives in 1 KiB writes; the codec keeps at
        // most one write of it.
        let mut member = vec![
            0x1f,
            0x8b,
            8,
            GzipHeader::FNAME | GzipHeader::FEXTRA,
            0,
            0,
            0,
            0,
            0,
            255,
        ];
        member.extend_from_slice(&3u16.to_le_bytes());
        member.extend_from_slice(b"xyz");
        member.extend(std::iter::repeat_n(b'n', 1 << 20));
        member.push(0);
        let body = run(&mut Codec::compressor(Format::DeflateRaw), &[b"fetchlet"]).unwrap();
        member.extend_from_slice(&body);
        let mut crc = Crc::new();
        crc.update(b"fetchlet");
        member.extend_from_slice(&crc.sum().to_le_bytes());
        member.extend_from_slice(&crc.amount().to_le_bytes());

        let mut codec = Codec::decompressor(Format::Gzip, None);
        let mut output = Vec::new();
        for chunk in member.chunks(1024) {
            codec.write(chunk).unwrap();
            assert!(codec.pending().len() <= 1024);
            while let Some(piece) = codec.read().unwrap() {
                output.extend(piece);
            }
            assert!(codec.pending().len() < 10);
        }
        codec.finish();
        while let Some(piece) = codec.read().unwrap() {
            output.extend(piece);
        }
        assert_eq!(output, b"fetchlet");
    }
}

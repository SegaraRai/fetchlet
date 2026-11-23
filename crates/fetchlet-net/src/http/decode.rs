use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use fetchlet::Error;
use fetchlet::http::HeaderMap;
use fetchlet::http::header::CONTENT_ENCODING;
use fetchlet_web::{CompressionFormat, Decompressor};
use http_body::{Body, Frame};

/// The codings the client asks for, which browsers ask for too.
pub(super) const ACCEPT_ENCODING: &str = "gzip, deflate, br";

/// A content coding the client undoes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Coding {
    Gzip,
    Deflate,
    Brotli,
}

/// The codings of a response's `Content-Encoding`, in the order to undo
/// them, or `None` when it names one the client does not know, which leaves
/// the body as it is.
pub(super) fn codings(headers: &HeaderMap) -> Option<Vec<Coding>> {
    let mut codings = Vec::new();
    for value in headers.get_all(CONTENT_ENCODING) {
        for token in value.to_str().ok()?.split(',') {
            match token.trim().to_ascii_lowercase().as_str() {
                "" | "identity" => {}
                "gzip" | "x-gzip" => codings.push(Coding::Gzip),
                "deflate" => codings.push(Coding::Deflate),
                "br" => codings.push(Coding::Brotli),
                _ => return None,
            }
        }
    }
    // The server applied them in the order listed.
    codings.reverse();
    Some(codings)
}

/// A response body with its content codings undone as it is read.
///
/// Each coding is a stage that the previous stage's output feeds, the first
/// fed by the network. A read returns at most one decompressor piece of
/// 64 KiB, so a small compressed chunk never inflates into one large frame;
/// the invocation's `response_body_bytes` budget applies to the decoded
/// bytes JavaScript reads.
pub(super) struct Decoded<B> {
    body: B,
    stages: Vec<Stage>,
    failed: bool,
}

impl<B> Decoded<B> {
    pub fn new(body: B, codings: &[Coding]) -> Self {
        Self {
            body,
            stages: codings.iter().copied().map(Stage::new).collect(),
            failed: false,
        }
    }

    /// The next output of stage `index`, pulling from the stages before
    /// it; `None` when it needs more network input or is complete.
    fn pull(&mut self, index: usize) -> fetchlet_web::Result<Option<Vec<u8>>> {
        loop {
            if let Some(output) = self.stages[index].read()? {
                return Ok(Some(output));
            }
            if self.stages[index].finished || index == 0 {
                return Ok(None);
            }
            match self.pull(index - 1)? {
                Some(input) => self.stages[index].write(&input)?,
                None if self.stages[index - 1].finished => self.stages[index].finish()?,
                None => return Ok(None),
            }
        }
    }

    fn fail(&mut self, message: String) -> Poll<Option<Result<Frame<Bytes>, Error>>> {
        self.failed = true;
        Poll::Ready(Some(Err(Error::Transport(message))))
    }
}

impl<B> Body for Decoded<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: std::fmt::Display,
{
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Error>>> {
        let this = self.get_mut();
        let last = this.stages.len() - 1;
        loop {
            if this.failed {
                return Poll::Ready(None);
            }
            match this.pull(last) {
                Err(error) => return this.fail(format!("cannot decode the response: {error}")),
                Ok(Some(output)) => return Poll::Ready(Some(Ok(Frame::data(output.into())))),
                Ok(None) if this.stages[last].finished => return Poll::Ready(None),
                Ok(None) => {}
            }
            let fed = match Pin::new(&mut this.body).poll_frame(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Err(error))) => {
                    return this.fail(format!("the response body failed: {error}"));
                }
                // Trailers carry no content; they are not forwarded.
                Poll::Ready(Some(Ok(frame))) => match frame.into_data() {
                    Ok(data) if !data.is_empty() => this.stages[0].write(&data),
                    _ => Ok(()),
                },
                Poll::Ready(None) => this.stages[0].finish(),
            };
            if let Err(error) = fed {
                return this.fail(format!("cannot decode the response: {error}"));
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.failed
    }
}

/// One coding's decompressor. `deflate` names zlib data, but some servers
/// send raw deflate, so a deflate stage reads two bytes before it chooses,
/// as browsers do.
struct Stage {
    coding: Coding,
    decoder: Option<Decompressor>,
    prefix: Vec<u8>,
    finished: bool,
}

impl Stage {
    fn new(coding: Coding) -> Self {
        let decoder = match coding {
            Coding::Gzip => Some(Decompressor::new(CompressionFormat::Gzip, None)),
            Coding::Brotli => Some(Decompressor::new(CompressionFormat::Brotli, None)),
            Coding::Deflate => None,
        };
        Self {
            coding,
            decoder,
            prefix: Vec::new(),
            finished: false,
        }
    }

    fn write(&mut self, input: &[u8]) -> fetchlet_web::Result<()> {
        if let Some(decoder) = &mut self.decoder {
            return decoder.write(input);
        }
        self.prefix.extend_from_slice(input);
        if self.prefix.len() >= 2 {
            self.choose()?;
        }
        Ok(())
    }

    fn finish(&mut self) -> fetchlet_web::Result<()> {
        if self.decoder.is_none() {
            self.choose()?;
        }
        if let Some(decoder) = &mut self.decoder {
            decoder.finish();
        }
        self.finished = true;
        Ok(())
    }

    fn read(&mut self) -> fetchlet_web::Result<Option<Vec<u8>>> {
        match &mut self.decoder {
            Some(decoder) => decoder.read(),
            None => Ok(None),
        }
    }

    /// Choose zlib or raw deflate by the first two bytes: a zlib header
    /// names the deflate method and is a multiple of 31 (RFC 1950).
    fn choose(&mut self) -> fetchlet_web::Result<()> {
        debug_assert_eq!(self.coding, Coding::Deflate);
        let zlib = match self.prefix[..] {
            [first, second, ..] => {
                first & 0x0f == 8 && (u16::from(first) << 8 | u16::from(second)) % 31 == 0
            }
            _ => false,
        };
        let format = if zlib {
            CompressionFormat::Deflate
        } else {
            CompressionFormat::DeflateRaw
        };
        let mut decoder = Decompressor::new(format, None);
        decoder.write(&std::mem::take(&mut self.prefix))?;
        self.decoder = Some(decoder);
        Ok(())
    }
}

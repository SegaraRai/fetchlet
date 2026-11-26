//! The frames between an isolated instance's parent and its child, over the
//! child's standard input and output: a one-byte kind, a four-byte
//! little-endian length and the payload, JSON or raw bytes by kind.
//!
//! Lengths are bounded only by the four-byte field. A reader never reserves
//! more than the bytes that actually arrive, so a frame that claims more
//! than it carries costs nothing, and the content of each frame is bounded
//! where it is used, by the same budgets as in-process (`Limits`).

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::execution::{Interrupted, StopReason};
use crate::{Backend, Error, Limits, Requirements};

/// What the child needs to build its engine.
#[derive(Serialize, Deserialize)]
pub(crate) struct Init {
    pub backend: Backend,
    pub source: String,
    pub requirements: Requirements,
    pub limits: Limits,
}

pub(crate) enum Frame {
    // Parent to child.
    Init(Box<Init>),
    /// An evaluation, with the time left until its deadline.
    Evaluate {
        expression: String,
        timeout_micros: Option<u64>,
    },
    /// A direct call of an export, as `Instance::call_json` makes it.
    Call {
        export: String,
        args: Vec<Value>,
    },
    /// The JSON reply of a host operation.
    Reply(String),
    /// The handle of bytes the child put into the byte store.
    Handle(Result<u64, Failure>),
    /// Bytes the child took from the byte store.
    Bytes(Result<Vec<u8>, Failure>),
    /// A host future the engine may wait on is ready.
    Wake,

    // Child to parent.
    Ready,
    Failed(Failure),
    Outcome {
        outcome: Outcome,
        reusable: bool,
    },
    Dispatch {
        operation: String,
        input: String,
    },
    PutBytes(Vec<u8>),
    TakeBytes(f64),
}

/// A `fetchlet::Error` as it crosses the boundary: its stable code and the
/// detail that stays on the Rust side.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Failure {
    code: String,
    detail: String,
}

impl From<&Error> for Failure {
    fn from(error: &Error) -> Self {
        let detail = match error {
            Error::Configuration(detail)
            | Error::InvalidRequest(detail)
            | Error::JavaScript(detail)
            | Error::Transport(detail)
            | Error::WorkerFailed(detail)
            | Error::InstanceLost(detail) => detail.clone(),
            Error::LimitExceeded(resource) => (*resource).to_owned(),
            _ => String::new(),
        };
        Self {
            code: error.code().to_owned(),
            detail,
        }
    }
}

impl Failure {
    pub fn into_error(self) -> Error {
        match self.code.as_str() {
            "CONFIGURATION" => Error::Configuration(self.detail),
            "INVALID_REQUEST" => Error::InvalidRequest(self.detail),
            "PERMISSION_DENIED" => Error::PermissionDenied,
            "LIMIT_EXCEEDED" => Error::LimitExceeded(limit_name(&self.detail)),
            "INVOCATION_CLOSED" => Error::InvocationClosed,
            "DEADLINE_EXCEEDED" => Error::DeadlineExceeded,
            "JAVASCRIPT" => Error::JavaScript(self.detail),
            "TRANSPORT" => Error::Transport(self.detail),
            "REENTRANT" => Error::Reentrant,
            "INSTANCE_LOST" => Error::InstanceLost(self.detail),
            _ => Error::InstanceUnavailable,
        }
    }
}

/// The resource names of the limits that cross the boundary, which
/// `Error::LimitExceeded` keeps as static strings.
fn limit_name(detail: &str) -> &'static str {
    const NAMES: &[&str] = &[
        "bridge message bytes",
        "engine busy time",
        "engine heap",
        "process memory",
    ];
    NAMES
        .iter()
        .find(|name| **name == detail)
        .copied()
        .unwrap_or("isolated instance resource")
}

/// How an evaluation ended in the child.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) enum Outcome {
    Value(Value),
    Interrupted(StopReason),
    JavaScript(String),
}

impl Outcome {
    pub fn from_result(result: anyhow::Result<Value>) -> Self {
        match result {
            Ok(value) => Self::Value(value),
            Err(error) => match error.downcast::<Interrupted>() {
                Ok(interrupted) => Self::Interrupted(interrupted.0),
                Err(error) => Self::JavaScript(error.to_string()),
            },
        }
    }

    pub fn into_result(self) -> anyhow::Result<Value> {
        match self {
            Self::Value(value) => Ok(value),
            Self::Interrupted(reason) => Err(Interrupted(reason).into()),
            Self::JavaScript(message) => Err(anyhow::Error::msg(message)),
        }
    }
}

const INIT: u8 = 1;
const EVALUATE: u8 = 2;
const CALL: u8 = 3;
const REPLY: u8 = 4;
const HANDLE: u8 = 5;
const BYTES: u8 = 6;
const BYTES_FAILED: u8 = 7;
const WAKE: u8 = 8;
const READY: u8 = 20;
const FAILED: u8 = 21;
const OUTCOME: u8 = 22;
const DISPATCH: u8 = 23;
const PUT_BYTES: u8 = 24;
const TAKE_BYTES: u8 = 25;

#[derive(Serialize, Deserialize)]
struct EvaluatePayload {
    expression: String,
    timeout_micros: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct CallPayload {
    export: String,
    args: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
struct OutcomePayload {
    outcome: Outcome,
    reusable: bool,
}

#[derive(Serialize, Deserialize)]
struct DispatchPayload {
    operation: String,
    input: String,
}

fn json(value: &impl Serialize) -> Vec<u8> {
    serde_json::to_vec(value).expect("frames serialize to JSON")
}

fn parse<T: for<'de> Deserialize<'de>>(payload: &[u8]) -> io::Result<T> {
    serde_json::from_slice(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

impl Frame {
    fn encode(&self) -> (u8, Vec<u8>) {
        match self {
            Self::Init(init) => (INIT, json(init)),
            Self::Evaluate {
                expression,
                timeout_micros,
            } => (
                EVALUATE,
                json(&EvaluatePayload {
                    expression: expression.clone(),
                    timeout_micros: *timeout_micros,
                }),
            ),
            Self::Call { export, args } => (
                CALL,
                json(&CallPayload {
                    export: export.clone(),
                    args: args.clone(),
                }),
            ),
            Self::Reply(reply) => (REPLY, reply.as_bytes().to_vec()),
            Self::Handle(handle) => (HANDLE, json(handle)),
            Self::Bytes(Ok(bytes)) => (BYTES, bytes.clone()),
            Self::Bytes(Err(failure)) => (BYTES_FAILED, json(failure)),
            Self::Wake => (WAKE, Vec::new()),
            Self::Ready => (READY, Vec::new()),
            Self::Failed(failure) => (FAILED, json(failure)),
            Self::Outcome { outcome, reusable } => (
                OUTCOME,
                json(&OutcomePayload {
                    outcome: outcome.clone(),
                    reusable: *reusable,
                }),
            ),
            Self::Dispatch { operation, input } => (
                DISPATCH,
                json(&DispatchPayload {
                    operation: operation.clone(),
                    input: input.clone(),
                }),
            ),
            Self::PutBytes(bytes) => (PUT_BYTES, bytes.clone()),
            Self::TakeBytes(handle) => (TAKE_BYTES, handle.to_le_bytes().to_vec()),
        }
    }

    fn decode(kind: u8, payload: Vec<u8>) -> io::Result<Self> {
        Ok(match kind {
            INIT => Self::Init(Box::new(parse(&payload)?)),
            EVALUATE => {
                let EvaluatePayload {
                    expression,
                    timeout_micros,
                } = parse(&payload)?;
                Self::Evaluate {
                    expression,
                    timeout_micros,
                }
            }
            CALL => {
                let CallPayload { export, args } = parse(&payload)?;
                Self::Call { export, args }
            }
            REPLY => Self::Reply(
                String::from_utf8(payload)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
            ),
            HANDLE => Self::Handle(parse(&payload)?),
            BYTES => Self::Bytes(Ok(payload)),
            BYTES_FAILED => Self::Bytes(Err(parse(&payload)?)),
            WAKE => Self::Wake,
            READY => Self::Ready,
            FAILED => Self::Failed(parse(&payload)?),
            OUTCOME => {
                let OutcomePayload { outcome, reusable } = parse(&payload)?;
                Self::Outcome { outcome, reusable }
            }
            DISPATCH => {
                let DispatchPayload { operation, input } = parse(&payload)?;
                Self::Dispatch { operation, input }
            }
            PUT_BYTES => Self::PutBytes(payload),
            TAKE_BYTES => {
                let bytes: [u8; 8] = payload
                    .try_into()
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad byte handle"))?;
                Self::TakeBytes(f64::from_le_bytes(bytes))
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unknown frame kind",
                ));
            }
        })
    }
}

/// Write one frame and flush it.
pub(crate) fn write(writer: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let (kind, payload) = frame.encode();
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&length.to_le_bytes());
    writer.write_all(&header)?;
    writer.write_all(&payload)?;
    writer.flush()
}

/// Read one frame, or None when the other side closed the stream between
/// frames.
pub(crate) fn read(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0u8; 5];
    let mut filled = 0;
    while filled < header.len() {
        match reader.read(&mut header[filled..])? {
            0 if filled == 0 => return Ok(None),
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            count => filled += count,
        }
    }
    let length = u32::from_le_bytes(header[1..].try_into().expect("four bytes"));
    let mut payload = Vec::new();
    reader
        .by_ref()
        .take(u64::from(length))
        .read_to_end(&mut payload)?;
    if payload.len() != length as usize {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Frame::decode(header[0], payload).map(Some)
}

/// Read frames from untrusted bytes as either end reads its pipe, and check
/// that each frame read writes back to bytes that read to the same frame.
/// For the `isolation_frames` fuzz target.
#[cfg(feature = "fuzzing")]
pub fn fuzz_frames(data: &[u8]) {
    let mut input = data;
    while let Ok(Some(frame)) = read(&mut input) {
        let mut written = Vec::new();
        write(&mut written, &frame).expect("a frame read writes back");
        let again = read(&mut written.as_slice())
            .expect("a written frame reads")
            .expect("a written frame is whole");
        let mut rewritten = Vec::new();
        write(&mut rewritten, &again).expect("a frame read writes back");
        assert_eq!(written, rewritten);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(frame: Frame) -> Frame {
        let mut buffer = Vec::new();
        write(&mut buffer, &frame).unwrap();
        read(&mut buffer.as_slice()).unwrap().unwrap()
    }

    #[test]
    fn frames_survive_the_stream() {
        assert!(matches!(
            round_trip(Frame::Dispatch {
                operation: "url.parse".into(),
                input: "[\"https://a.test\"]".into(),
            }),
            Frame::Dispatch { operation, .. } if operation == "url.parse"
        ));
        assert!(matches!(
            round_trip(Frame::TakeBytes(42.0)),
            Frame::TakeBytes(handle) if handle == 42.0
        ));
        assert!(matches!(
            round_trip(Frame::Bytes(Ok(vec![1, 2, 3]))),
            Frame::Bytes(Ok(bytes)) if bytes == [1, 2, 3]
        ));
        let failure = Failure::from(&Error::LimitExceeded("engine heap"));
        let Frame::Failed(failure) = round_trip(Frame::Failed(failure)) else {
            panic!("expected Failed");
        };
        assert!(matches!(
            failure.into_error(),
            Error::LimitExceeded("engine heap")
        ));
    }

    #[test]
    fn a_closed_stream_between_frames_is_the_end() {
        assert!(read(&mut [].as_slice()).unwrap().is_none());
    }

    #[test]
    fn truncated_or_unknown_frames_are_refused_without_reserving_their_length() {
        // A header that claims 4 GiB but carries three bytes.
        let lying = [DISPATCH, 0xff, 0xff, 0xff, 0xff, b'{', b'}', b'x'];
        assert!(read(&mut lying.as_slice()).is_err());
        let unknown = [99, 0, 0, 0, 0];
        assert!(read(&mut unknown.as_slice()).is_err());
        let half_header = [DISPATCH, 1];
        assert!(read(&mut half_header.as_slice()).is_err());
    }
}

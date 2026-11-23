use serde_json::Value;
use tokio::sync::oneshot;

use crate::{Call, Request, Response, Result};

/// Work sent from an [`AppHandle`](super::AppHandle) to its worker thread.
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    expect(
        dead_code,
        reason = "only an engine runs the worker that reads commands"
    )
)]
pub(super) enum Command {
    Call {
        call: Call,
        reply: oneshot::Sender<Result<Value>>,
    },
    Fetch {
        request: Box<Request>,
        context: Option<Value>,
        reply: oneshot::Sender<Result<Response>>,
    },
}

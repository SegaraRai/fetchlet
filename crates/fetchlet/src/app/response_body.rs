use std::time::Instant;

use bytes::Bytes;
use serde::Deserialize;

use super::App;
use crate::bridge::InvocationScope;
use crate::execution::{ResponseBodyOperation, response_body_operation};
use crate::wire::{ByteTransport, WireBytes};
use crate::{Error, Result};

/// A JavaScript response body left open by a Fetch invocation.
///
/// It owns the invocation's host scope and deadline. Consuming it with
/// [`App::pull_response_body`] to the end, or with
/// [`App::cancel_response_body`], ends the invocation.
pub(crate) struct OpenResponseBody {
    id: u64,
    scope: InvocationScope,
    deadline: Option<Instant>,
    received: usize,
}

impl OpenResponseBody {
    pub(super) fn new(
        id: u64,
        scope: InvocationScope,
        deadline: Option<Instant>,
        received: usize,
    ) -> Self {
        Self {
            id,
            scope,
            deadline,
            received,
        }
    }

    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
}

/// Bytes pulled from an open body, and the body when more may follow.
pub(crate) struct PulledChunk {
    pub chunk: Bytes,
    pub next: Option<OpenResponseBody>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePull {
    chunk: WireBytes,
    done: bool,
}

impl App {
    /// Wait for the next available bytes of an open body.
    ///
    /// The response byte budget applies to the whole body. On an error the
    /// JavaScript side has already released the body and the invocation ends.
    pub(crate) async fn pull_response_body(
        &mut self,
        mut open: OpenResponseBody,
    ) -> Result<PulledChunk> {
        let expression = response_body_operation(ResponseBodyOperation::Pull, open.id);
        let value = match self.evaluate(expression, open.deadline).await {
            Ok(value) => value,
            Err(error) => {
                self.close(open.scope);
                return Err(error);
            }
        };
        let pulled: WirePull = match serde_json::from_value(value) {
            Ok(pulled) => pulled,
            Err(error) => {
                self.reusable = false;
                self.close(open.scope);
                return Err(Error::JavaScript(format!(
                    "invalid response body chunk: {error}"
                )));
            }
        };
        let chunk = match self.host.receive(pulled.chunk) {
            Ok(chunk) => chunk,
            Err(error) => {
                self.reusable = false;
                self.close(open.scope);
                return Err(error);
            }
        };
        open.received = open.received.saturating_add(chunk.len());
        if let Err(error) = self.check_response_bytes(open.received) {
            if pulled.done {
                self.close(open.scope);
            } else {
                self.cancel_response_body(open).await;
            }
            return Err(error);
        }
        if pulled.done {
            self.close(open.scope);
            return Ok(PulledChunk { chunk, next: None });
        }
        Ok(PulledChunk {
            chunk,
            next: Some(open),
        })
    }

    /// Cancel the JavaScript stream and end the invocation.
    ///
    /// A cancel that cannot complete within the deadline retires the instance.
    pub(crate) async fn cancel_response_body(&mut self, open: OpenResponseBody) {
        let expression = response_body_operation(ResponseBodyOperation::Cancel, open.id);
        // The evaluation records whether the instance stays reusable.
        let _ = self.evaluate(expression, open.deadline).await;
        self.close(open.scope);
    }
}

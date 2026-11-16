use std::future::Future;

use serde_json::Value;
use tokio::sync::oneshot;

use super::streaming::stream_response_body;
use crate::{App, Body, Error, Request, Response, Result};

pub(super) enum Command {
    Call {
        export: String,
        arguments: Vec<Value>,
        reply: oneshot::Sender<Result<Value>>,
    },
    Fetch {
        request: Box<Request>,
        context: Option<Value>,
        reply: oneshot::Sender<Result<Response>>,
    },
}

impl Command {
    pub fn is_cancelled(&self) -> bool {
        match self {
            Self::Call { reply, .. } => reply.is_closed(),
            Self::Fetch { reply, .. } => reply.is_closed(),
        }
    }

    pub fn reject(self, error: Error) {
        match self {
            Self::Call { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Fetch { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }

    /// Execute on the worker. A streaming Fetch response keeps the worker,
    /// and with it the instance, until its body finishes or is dropped.
    pub async fn execute(self, app: &mut App, response_body_queue: usize) {
        match self {
            Self::Call {
                export,
                arguments,
                reply,
            } => {
                complete(reply, app.call_json(&export, &arguments)).await;
            }
            Self::Fetch {
                request,
                context,
                mut reply,
            } => {
                let head = tokio::select! {
                    head = app.fetch_head(*request, context) => head,
                    () = reply.closed() => return,
                };
                let (response, open) = match head {
                    Ok(head) => head,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let Some(open) = open else {
                    let _ = reply.send(Ok(response));
                    return;
                };
                let (parts, body) = response.into_parts();
                let prefix = match body.collect_within(None, "response body bytes").await {
                    Ok(prefix) => prefix,
                    Err(error) => {
                        app.cancel_response_body(open).await;
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let (sender, body) = Body::channel(prefix, response_body_queue);
                if reply.send(Ok(Response::from_parts(parts, body))).is_err() {
                    app.cancel_response_body(open).await;
                    return;
                }
                stream_response_body(app, open, sender).await;
            }
        }
    }
}

async fn complete<T>(
    mut reply: oneshot::Sender<Result<T>>,
    execution: impl Future<Output = Result<T>>,
) {
    tokio::select! {
        result = execution => {
            let _ = reply.send(result);
        }
        () = reply.closed() => {}
    }
}

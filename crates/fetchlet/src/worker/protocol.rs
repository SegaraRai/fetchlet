use std::future::Future;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::{App, Error, Request, Response, Result};

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

    pub async fn execute(self, app: &mut App) {
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
                reply,
            } => {
                let execution = async {
                    match context {
                        Some(context) => app.fetch_with_context(*request, &context).await,
                        None => app.fetch(*request).await,
                    }
                };
                complete(reply, execution).await;
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

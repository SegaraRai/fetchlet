use std::any::Any;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::thread;

use tokio::sync::{mpsc, oneshot, watch};

use super::lifecycle::WorkerStatus;
use super::protocol::Command;
use super::streaming::stream_response_body;
use super::{CancelledCalls, WorkerOptions};
use crate::{App, AppBuilder, Body, Error, Response, Result};

pub(super) fn spawn(
    builder: AppBuilder,
    options: WorkerOptions,
    receiver: mpsc::Receiver<Command>,
    shutdown: watch::Receiver<bool>,
    initialized: oneshot::Sender<Result<()>>,
    status: watch::Sender<WorkerStatus>,
) -> Result<()> {
    let mut thread = thread::Builder::new().name("fetchlet-app".into());
    if let Some(size) = options.stack_size_bytes {
        thread = thread.stack_size(size.get());
    }
    thread
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                let executor = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| Error::WorkerFailed(error.to_string()))?;
                let _entered = executor.enter();
                let app = match builder.clone().build() {
                    Ok(app) => app,
                    Err(error) => {
                        let _ = initialized.send(Err(error));
                        return Ok(());
                    }
                };
                if initialized.send(Ok(())).is_err() {
                    return Ok(());
                }
                let execution = Execution {
                    response_body_queue: options.response_body_queue.get(),
                    cancelled_calls: options.cancelled_calls,
                };
                executor.block_on(serve(receiver, shutdown, app, builder, execution));
                Ok(())
            }));
            let outcome = match result {
                Ok(result) => result.map_err(|error: Error| error.to_string()),
                Err(payload) => Err(panic_message(payload)),
            };
            status.send_replace(WorkerStatus::Finished(outcome));
        })
        .map_err(|error| Error::WorkerFailed(error.to_string()))?;
    Ok(())
}

async fn serve(
    mut receiver: mpsc::Receiver<Command>,
    mut shutdown: watch::Receiver<bool>,
    mut app: App,
    builder: AppBuilder,
    execution: Execution,
) {
    let mut draining = false;
    loop {
        let command = tokio::select! {
            command = receiver.recv() => command,
            _ = shutdown.wait_for(|requested| *requested), if !draining => {
                receiver.close();
                draining = true;
                continue;
            }
        };
        let Some(command) = command else {
            return;
        };
        if command.is_cancelled() {
            continue;
        }
        if !app.is_reusable() {
            app = match builder.clone().build() {
                Ok(app) => app,
                Err(error) => {
                    command.reject(error);
                    continue;
                }
            };
        }
        command.execute(&mut app, execution).await;
        // Background work runs after the reply, before the next command. A
        // failure retires the instance, which the next command rebuilds.
        let _ = app.finish_background().await;
    }
}

/// How the worker runs each command.
#[derive(Clone, Copy)]
pub struct Execution {
    /// See [`WorkerOptions::response_body_queue`].
    pub response_body_queue: usize,
    pub cancelled_calls: CancelledCalls,
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
    pub async fn execute(self, app: &mut App, execution: Execution) {
        let finish = execution.cancelled_calls == CancelledCalls::Finish;
        match self {
            Self::Call {
                export,
                arguments,
                reply,
            } => {
                complete(reply, app.call_json(&export, &arguments), finish).await;
            }
            Self::Fetch {
                request,
                context,
                mut reply,
            } => {
                let disconnect = app.disconnect();
                let head = if finish {
                    // The handler sees its request's signal abort when the
                    // caller leaves, and the closed reply fails the send
                    // below, which cancels an open body.
                    let head = app.fetch_head(*request, context, Some(disconnect.clone()));
                    tokio::pin!(head);
                    tokio::select! {
                        head = &mut head => head,
                        () = reply.closed() => {
                            disconnect.signal();
                            head.await
                        }
                    }
                } else {
                    tokio::select! {
                        head = app.fetch_head(*request, context, None) => head,
                        () = reply.closed() => return,
                    }
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
                let (sender, body) = Body::channel(prefix, execution.response_body_queue);
                if reply.send(Ok(Response::from_parts(parts, body))).is_err() {
                    app.cancel_response_body(open).await;
                    return;
                }
                stream_response_body(app, open, sender, finish.then_some(disconnect)).await;
            }
        }
    }
}

async fn complete<T>(
    mut reply: oneshot::Sender<Result<T>>,
    execution: impl Future<Output = Result<T>>,
    finish: bool,
) {
    if finish {
        let _ = reply.send(execution.await);
        return;
    }
    tokio::select! {
        result = execution => {
            let _ = reply.send(result);
        }
        () = reply.closed() => {}
    }
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    "Rust worker panicked".into()
}

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::thread;

use tokio::sync::{mpsc, oneshot, watch};

use super::WorkerOptions;
use super::lifecycle::{WorkerStatus, panic_message};
use super::protocol::Command;
use crate::{App, AppBuilder, Error, Result};

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
                let response_body_queue = options.response_body_queue.get();
                executor.block_on(serve(receiver, shutdown, app, builder, response_body_queue));
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
    response_body_queue: usize,
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
        command.execute(&mut app, response_body_queue).await;
    }
}

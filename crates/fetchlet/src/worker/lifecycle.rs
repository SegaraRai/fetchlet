use std::any::Any;

use tokio::sync::watch;

use crate::{Error, Result};

#[derive(Clone)]
pub(super) enum WorkerStatus {
    Running,
    Finished(std::result::Result<(), String>),
}

pub(super) async fn wait_for_shutdown(mut status: watch::Receiver<WorkerStatus>) -> Result<()> {
    loop {
        let current = status.borrow().clone();
        if let WorkerStatus::Finished(result) = current {
            return result.map_err(Error::WorkerFailed);
        }
        status.changed().await.map_err(|_| {
            Error::WorkerFailed("worker exited before reporting its final state".into())
        })?;
    }
}

pub(super) fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    "Rust worker panicked".into()
}

use tokio::sync::watch;

use crate::{Error, Result};

#[derive(Clone)]
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    expect(dead_code, reason = "only an engine runs a worker")
)]
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

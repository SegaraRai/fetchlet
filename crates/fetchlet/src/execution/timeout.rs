use std::future::Future;
use std::time::Duration;

use crate::{Error, Result};

pub(crate) async fn with_timeout<F>(timeout: Option<Duration>, future: F) -> Result<F::Output>
where
    F: Future,
{
    match timeout {
        Some(timeout) if timeout.is_zero() => Err(Error::DeadlineExceeded),
        Some(timeout) => tokio::time::timeout(timeout, future)
            .await
            .map_err(|_| Error::DeadlineExceeded),
        None => Ok(future.await),
    }
}

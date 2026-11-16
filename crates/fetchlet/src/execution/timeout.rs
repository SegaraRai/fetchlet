use std::future::Future;
use std::time::Duration;
#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
use std::time::Instant;

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

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
/// The deadline of an invocation that spans several engine evaluations.
pub(crate) fn deadline_after(timeout: Option<Duration>) -> Option<Instant> {
    // Limits::validate rejects timeouts beyond the platform clock range.
    timeout.and_then(|timeout| Instant::now().checked_add(timeout))
}

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
pub(crate) async fn with_deadline<F>(deadline: Option<Instant>, future: F) -> Result<F::Output>
where
    F: Future,
{
    match deadline {
        Some(deadline) if deadline <= Instant::now() => Err(Error::DeadlineExceeded),
        Some(deadline) => tokio::time::timeout_at(deadline.into(), future)
            .await
            .map_err(|_| Error::DeadlineExceeded),
        None => Ok(future.await),
    }
}

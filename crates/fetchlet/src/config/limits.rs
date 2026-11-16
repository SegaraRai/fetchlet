use std::time::{Duration, Instant};

use crate::{Error, Result};

/// Resource budgets selected by the embedding application.
///
/// Each Some value enables that budget. None delegates the resource budget to
/// the surrounding host, such as an HTTP server or a process supervisor.
#[derive(Debug, Clone, Default)]
pub struct Limits {
    /// Cooperative duration of one invocation, including host I/O and timers.
    pub timeout: Option<Duration>,
    /// Byte budget for each input or outbound request body.
    pub request_body_bytes: Option<usize>,
    /// Chunk budget when reading a guest outbound request, including empty chunks.
    pub request_body_chunks: Option<usize>,
    /// Byte budget for each output or upstream response body.
    pub response_body_bytes: Option<usize>,
    /// Combined name and value bytes in one header collection.
    pub header_bytes: Option<usize>,
    /// URL bytes at request conversion and after trusted rewrites.
    pub url_bytes: Option<usize>,
    /// Bytes in each JSON input to a native host callback.
    pub bridge_message_bytes: Option<usize>,
    /// Input bytes for one host SHA-256 operation.
    pub digest_bytes: Option<usize>,
    /// Host fetch starts attempted during one invocation, including failed starts.
    pub subrequests: Option<usize>,
    /// Redirects followed per fetch, within the Fetch specification's limit.
    pub redirects: Option<usize>,
}

impl Limits {
    pub(crate) fn validate(&self) -> Result<()> {
        let exceeds_clock_range = self
            .timeout
            .is_some_and(|timeout| Instant::now().checked_add(timeout).is_none());
        if exceeds_clock_range {
            return Err(Error::Configuration(
                "timeout exceeds the platform clock range".into(),
            ));
        }

        Ok(())
    }
}

pub(crate) fn check_limit(
    limit: Option<usize>,
    observed: usize,
    resource: &'static str,
) -> Result<()> {
    if limit.is_some_and(|limit| observed > limit) {
        return Err(Error::LimitExceeded(resource));
    }

    Ok(())
}

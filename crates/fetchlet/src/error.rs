/// Failures at the Rust/JavaScript execution and host-service boundaries.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid configuration: {0}")]
    Configuration(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("host operation is not permitted")]
    PermissionDenied,
    #[error("resource limit exceeded: {0}")]
    LimitExceeded(&'static str),
    #[error("invocation is closed")]
    InvocationClosed,
    #[error("invocation deadline exceeded")]
    DeadlineExceeded,
    #[error("instance cannot be reused after an interrupted or unfinished call")]
    InstanceUnavailable,
    #[error("JavaScript execution failed: {0}")]
    JavaScript(String),
    #[error("application worker is closed")]
    WorkerClosed,
    #[error("application worker failed: {0}")]
    WorkerFailed(String),
    #[error("transport failed: {0}")]
    Transport(String),
}

impl Error {
    /// Keep provider diagnostics and configuration values on the Rust side.
    #[cfg(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    ))]
    pub(crate) fn guest_message(&self) -> &'static str {
        match self {
            Self::Configuration(_) => "invalid host configuration",
            Self::InvalidRequest(_) => "invalid host request",
            Self::PermissionDenied => "host operation is not permitted",
            Self::LimitExceeded(_) => "host resource limit exceeded",
            Self::InvocationClosed => "invocation is closed",
            Self::DeadlineExceeded => "invocation deadline exceeded",
            Self::InstanceUnavailable => "instance is unavailable",
            Self::JavaScript(_) => "JavaScript execution failed",
            Self::Transport(_) => "host transport failed",
            Self::WorkerClosed => "application worker is closed",
            Self::WorkerFailed(_) => "application worker failed",
        }
    }

    #[cfg(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    ))]
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Configuration(_) => "CONFIGURATION",
            Self::InvalidRequest(_) => "INVALID_REQUEST",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::LimitExceeded(_) => "LIMIT_EXCEEDED",
            Self::InvocationClosed => "INVOCATION_CLOSED",
            Self::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Self::InstanceUnavailable => "INSTANCE_UNAVAILABLE",
            Self::JavaScript(_) => "JAVASCRIPT",
            Self::Transport(_) => "TRANSPORT",
            Self::WorkerClosed => "WORKER_CLOSED",
            Self::WorkerFailed(_) => "WORKER_FAILED",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

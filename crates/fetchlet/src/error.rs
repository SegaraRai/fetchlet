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
    /// A call to an application from its own host fetch would wait for itself.
    #[error("an application cannot be called from its own host fetch")]
    Reentrant,
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
            Self::Reentrant => "reentrant application call",
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
            Self::Reentrant => "REENTRANT",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(feature = "web")]
impl From<fetchlet_web::Error> for Error {
    fn from(error: fetchlet_web::Error) -> Self {
        match error {
            fetchlet_web::Error::InvalidRequest(message) => Self::InvalidRequest(message),
            fetchlet_web::Error::LimitExceeded(resource) => Self::LimitExceeded(resource),
            fetchlet_web::Error::UnknownOperation => Self::PermissionDenied,
            fetchlet_web::Error::NoInvocation => Self::InvocationClosed,
            fetchlet_web::Error::Unavailable(facility) => Self::Transport(facility.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_kind() -> Vec<Error> {
        vec![
            Error::Configuration("secret path /etc/app".into()),
            Error::InvalidRequest("secret header value".into()),
            Error::PermissionDenied,
            Error::LimitExceeded("request body bytes"),
            Error::InvocationClosed,
            Error::DeadlineExceeded,
            Error::InstanceUnavailable,
            Error::JavaScript("secret stack".into()),
            Error::WorkerClosed,
            Error::WorkerFailed("secret panic".into()),
            Error::Transport("secret upstream".into()),
            Error::Reentrant,
        ]
    }

    #[test]
    fn guests_see_fixed_messages_without_host_details() {
        for error in every_kind() {
            let message = error.guest_message();
            assert!(!message.contains("secret"), "{error}: {message}");
            assert!(
                !message.contains("request body bytes"),
                "{error}: {message}"
            );
        }
    }

    #[test]
    fn each_kind_has_its_own_code() {
        let codes: Vec<_> = every_kind().iter().map(Error::code).collect();
        let mut unique = codes.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), codes.len(), "{codes:?}");
        assert!(codes.iter().all(|code| {
            code.bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
        }));
    }

    #[test]
    fn rust_messages_keep_the_details() {
        assert_eq!(
            Error::LimitExceeded("URL bytes").to_string(),
            "resource limit exceeded: URL bytes"
        );
        assert_eq!(
            Error::Configuration("bad".into()).to_string(),
            "invalid configuration: bad"
        );
    }

    #[cfg(feature = "web")]
    #[test]
    fn web_api_errors_map_onto_host_errors() {
        use fetchlet_web::Error as Web;
        assert!(matches!(
            Error::from(Web::InvalidRequest("x".into())),
            Error::InvalidRequest(message) if message == "x"
        ));
        assert!(matches!(
            Error::from(Web::LimitExceeded("digest bytes")),
            Error::LimitExceeded("digest bytes")
        ));
        assert!(matches!(
            Error::from(Web::UnknownOperation),
            Error::PermissionDenied
        ));
        assert!(matches!(
            Error::from(Web::NoInvocation),
            Error::InvocationClosed
        ));
        assert!(matches!(
            Error::from(Web::Unavailable("random source")),
            Error::Transport(message) if message == "random source"
        ));
    }
}

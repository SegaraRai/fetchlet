/// A failed Web API operation. Embedders map each kind onto their own
/// guest-visible error codes.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The message does not match the operation's protocol.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    /// A caller budget in [`WebLimits`](crate::WebLimits) or a limit of the
    /// specification was exceeded.
    #[error("resource limit exceeded: {0}")]
    LimitExceeded(&'static str),
    /// The operation does not exist in this build.
    #[error("unknown Web API operation")]
    UnknownOperation,
    /// The operation keeps per-invocation state and no invocation is active.
    #[error("the operation needs an active invocation")]
    NoInvocation,
    /// A system facility, such as the random source, failed.
    #[error("unavailable: {0}")]
    Unavailable(&'static str),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

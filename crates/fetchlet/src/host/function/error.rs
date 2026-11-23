use std::fmt;

use crate::Error;

/// The failure of a [`Functions`](super::Functions) method.
///
/// [`FunctionError::new`] reaches JavaScript as an `Error` with its message
/// and, with [`code`](Self::code), its `code` property. A fetchlet [`Error`]
/// reaches JavaScript with its generic code and message only, as other host
/// operations report it, so its detail stays in Rust.
pub struct FunctionError {
    kind: Kind,
}

#[cfg_attr(
    not(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    )),
    allow(dead_code, reason = "only the host bridge calls methods")
)]
enum Kind {
    Application {
        message: String,
        code: Option<String>,
    },
    /// The arguments did not deserialize; the detail stays in Rust.
    Arguments(String),
    Host(Error),
    Panicked,
}

impl FunctionError {
    /// An error JavaScript receives with `message`.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            kind: Kind::Application {
                message: message.into(),
                code: None,
            },
        }
    }

    /// Set the error's `code` property in JavaScript. A fetchlet error
    /// keeps its own code.
    pub fn code(mut self, code: impl Into<String>) -> Self {
        if let Kind::Application { code: slot, .. } = &mut self.kind {
            *slot = Some(code.into());
        }
        self
    }

    /// Arguments that did not deserialize, which JavaScript receives as a
    /// `TypeError` naming the method.
    pub(super) fn arguments(detail: String) -> Self {
        Self {
            kind: Kind::Arguments(detail),
        }
    }
}

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
impl FunctionError {
    pub(crate) fn panicked() -> Self {
        Self {
            kind: Kind::Panicked,
        }
    }

    /// The error as the bridge sends it: `kind` tells JavaScript which
    /// error to build, with fetchlet errors as other host errors are.
    pub(crate) fn describe(&self) -> serde_json::Value {
        match &self.kind {
            Kind::Application { message, code } => {
                serde_json::json!({ "kind": "application", "code": code, "message": message })
            }
            Kind::Arguments(_) => {
                serde_json::json!({ "kind": "arguments", "code": "INVALID_ARGUMENTS", "message": "invalid arguments" })
            }
            Kind::Host(error) => {
                serde_json::json!({ "code": error.code(), "message": error.guest_message() })
            }
            Kind::Panicked => {
                serde_json::json!({ "code": "PANICKED", "message": "host function panicked" })
            }
        }
    }
}

impl From<Error> for FunctionError {
    fn from(error: Error) -> Self {
        Self {
            kind: Kind::Host(error),
        }
    }
}

impl fmt::Display for FunctionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            Kind::Application {
                message,
                code: Some(code),
            } => write!(formatter, "{code}: {message}"),
            Kind::Application { message, .. } => formatter.write_str(message),
            Kind::Arguments(detail) => write!(formatter, "invalid arguments: {detail}"),
            Kind::Host(error) => error.fmt(formatter),
            Kind::Panicked => formatter.write_str("host function panicked"),
        }
    }
}

impl fmt::Debug for FunctionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "FunctionError({self})")
    }
}

impl std::error::Error for FunctionError {}

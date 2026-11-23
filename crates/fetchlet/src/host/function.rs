use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::Context;
use crate::Error;

/// The future of an async method of a [`Functions`] binding.
pub type FunctionFuture = Pin<Box<dyn Future<Output = Result<Value, FunctionError>> + Send>>;

type AsyncMethod = dyn Fn(FunctionRequest) -> FunctionFuture + Send + Sync;
type SyncMethod = dyn Fn(FunctionRequest) -> Result<Value, FunctionError> + Send + Sync;

/// Rust functions that JavaScript calls as the methods of `env.NAME`.
///
/// Bind them with [`HostServices::functions`](crate::HostServices::functions).
/// `env.NAME` is a frozen object with exactly these methods. Arguments
/// arrive as the JSON array `JSON.stringify` makes of them, and a result is
/// any JSON value, which JavaScript receives parsed.
///
/// An async method returns a Promise in JavaScript; its future is polled
/// with the invocation's host operations, the invocation's deadline applies
/// to it, and it is dropped when the invocation ends. A sync method returns
/// its result at once and blocks JavaScript while it runs, with no deadline,
/// so it must be quick, such as a lookup in memory.
#[derive(Clone, Default)]
pub struct Functions {
    methods: BTreeMap<String, Method>,
    /// The first name that cannot be a method, reported when bound.
    invalid: Option<String>,
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
#[derive(Clone)]
pub(crate) enum Method {
    Async(Arc<AsyncMethod>),
    Sync(Arc<SyncMethod>),
}

impl Functions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an async method. JavaScript's call returns a Promise of its result.
    pub fn method<F, R>(self, name: impl Into<String>, method: F) -> Self
    where
        F: Fn(FunctionRequest) -> R + Send + Sync + 'static,
        R: Future<Output = Result<Value, FunctionError>> + Send + 'static,
    {
        self.insert(
            name.into(),
            Method::Async(Arc::new(move |request| Box::pin(method(request)))),
        )
    }

    /// Add a sync method. JavaScript's call returns its result, and waits
    /// for it on the thread that runs the instance.
    pub fn sync_method<F>(self, name: impl Into<String>, method: F) -> Self
    where
        F: Fn(FunctionRequest) -> Result<Value, FunctionError> + Send + Sync + 'static,
    {
        self.insert(name.into(), Method::Sync(Arc::new(method)))
    }

    /// Record a method. `then` would make the binding a thenable, which
    /// `await` and Promise resolution call, and a name may appear once.
    fn insert(mut self, name: String, method: Method) -> Self {
        if self.invalid.is_none() && (name == "then" || self.methods.contains_key(&name)) {
            self.invalid = Some(name.clone());
        }
        self.methods.insert(name, method);
        self
    }

    pub(crate) fn validate(&self) -> crate::Result<()> {
        match &self.invalid {
            Some(name) if name == "then" => Err(Error::Configuration(
                "a function binding cannot have a method named then".into(),
            )),
            Some(name) => Err(Error::Configuration(format!(
                "duplicate function method {name}"
            ))),
            None => Ok(()),
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
impl Functions {
    pub(crate) fn get(&self, name: &str) -> Option<&Method> {
        self.methods.get(name)
    }

    /// Each method's name and whether it is `"sync"` or `"async"`, as
    /// JavaScript builds the binding from them.
    pub(crate) fn describe(&self) -> Value {
        let methods: serde_json::Map<String, Value> = self
            .methods
            .iter()
            .map(|(name, method)| {
                let kind = match method {
                    Method::Async(_) => "async",
                    Method::Sync(_) => "sync",
                };
                (name.clone(), Value::from(kind))
            })
            .collect();
        Value::Object(methods)
    }
}

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
impl FunctionRequest {
    pub(crate) fn new(method: String, args: Value, context: Option<Context>) -> Self {
        Self {
            method,
            args,
            context: context.unwrap_or_default(),
        }
    }
}

/// What a [`Functions`] method receives when JavaScript calls it: the
/// method's name, its arguments and the invocation's trusted `Context`.
pub struct FunctionRequest {
    method: String,
    args: Value,
    context: Context,
}

impl FunctionRequest {
    /// The name of the method JavaScript called.
    pub fn method(&self) -> &str {
        &self.method
    }

    /// The trusted values the caller attached to the invocation, empty when
    /// it attached none. JavaScript cannot read or change them.
    pub fn context(&self) -> &Context {
        &self.context
    }

    /// The arguments as `T`, usually a tuple with one element per argument,
    /// or `Vec<Value>` for any number. A tuple needs exactly its number of
    /// arguments; an argument JavaScript passes as `undefined` arrives as
    /// `null`. Arguments that do not deserialize fail the call with a
    /// `TypeError` in JavaScript that names the method.
    pub fn args<T: DeserializeOwned>(&self) -> Result<T, FunctionError> {
        T::deserialize(&self.args).map_err(|error| FunctionError {
            kind: Kind::Arguments(error.to_string()),
        })
    }

    /// The arguments as the JSON array JavaScript sent.
    pub fn raw_args(&self) -> &Value {
        &self.args
    }
}

impl fmt::Debug for FunctionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FunctionRequest")
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}

/// The failure of a [`Functions`] method.
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
    pub(crate) fn describe(&self) -> Value {
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

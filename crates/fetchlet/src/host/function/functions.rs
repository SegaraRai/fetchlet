use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::{FunctionError, FunctionRequest, FunctionResponse};
use crate::Error;

/// The future of an async method of a [`Functions`] binding.
pub type FunctionFuture =
    Pin<Box<dyn Future<Output = Result<FunctionResponse, FunctionError>> + Send>>;

type AsyncMethod = dyn Fn(FunctionRequest) -> FunctionFuture + Send + Sync;
type SyncMethod = dyn Fn(FunctionRequest) -> Result<FunctionResponse, FunctionError> + Send + Sync;

/// Rust functions that JavaScript calls as the methods of `env.NAME`.
///
/// Bind them with [`HostServices::functions`](crate::HostServices::functions).
/// `env.NAME` is a frozen object with exactly these methods. Arguments
/// arrive as the JSON array `JSON.stringify` makes of them, with each byte
/// array JavaScript passes kept as bytes ([`FunctionRequest::args`]). A
/// result is a JSON value, which JavaScript receives parsed, and may carry
/// byte arrays and channels at positions inside it ([`FunctionResponse`]).
///
/// A method returns any type that converts into a [`FunctionResponse`],
/// such as `serde_json::Value` or `bytes::Bytes`. A method that only fails
/// names its result type, as in `Err::<Value, _>(error)`.
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
    pub fn method<F, Fut, R>(self, name: impl Into<String>, method: F) -> Self
    where
        F: Fn(FunctionRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, FunctionError>> + Send + 'static,
        R: Into<FunctionResponse> + 'static,
    {
        self.insert(
            name.into(),
            Method::Async(Arc::new(move |request| {
                let future = method(request);
                Box::pin(async move { future.await.map(Into::into) })
            })),
        )
    }

    /// Add a sync method. JavaScript's call returns its result, and waits
    /// for it on the thread that runs the instance.
    pub fn sync_method<F, R>(self, name: impl Into<String>, method: F) -> Self
    where
        F: Fn(FunctionRequest) -> Result<R, FunctionError> + Send + Sync + 'static,
        R: Into<FunctionResponse>,
    {
        self.insert(
            name.into(),
            Method::Sync(Arc::new(move |request| method(request).map(Into::into))),
        )
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
    pub(crate) fn describe(&self) -> serde_json::Value {
        let methods: serde_json::Map<String, serde_json::Value> = self
            .methods
            .iter()
            .map(|(name, method)| {
                let kind = match method {
                    Method::Async(_) => "async",
                    Method::Sync(_) => "sync",
                };
                (name.clone(), serde_json::Value::from(kind))
            })
            .collect();
        serde_json::Value::Object(methods)
    }
}

use std::sync::Arc;

use serde_json::Value;

use super::{Backend, CodeCache, Startup};
use crate::bridge::HostBridge;
use crate::execution::Interrupted;
use crate::{Error, Instance, Limits, Module, Result};

pub(crate) enum Engine {
    #[cfg(feature = "quickjs")]
    QuickJs(super::QuickJs),
    #[cfg(feature = "boa")]
    Boa(Box<super::Boa>),
    #[cfg(feature = "v8")]
    V8(super::V8),
}

impl Engine {
    pub(crate) fn new(
        backend: Backend,
        module: &Module,
        host: HostBridge,
        code_cache: Arc<CodeCache>,
        limits: &Limits,
    ) -> Result<Self> {
        let startup = Startup::new(module, &backend, code_cache, limits);
        let result = match backend {
            #[cfg(feature = "quickjs")]
            Backend::QuickJs(options) => {
                super::QuickJs::with_host(&startup, host, options).map(Self::QuickJs)
            }
            #[cfg(feature = "boa")]
            Backend::Boa(options) => super::Boa::with_host(&startup, host, options)
                .map(|engine| Self::Boa(Box::new(engine))),
            #[cfg(feature = "v8")]
            Backend::V8(options) => super::V8::with_host(&startup, host, options).map(Self::V8),
        };
        // An unmet requirement keeps its own error; anything else the
        // engine reported while starting is JavaScript's.
        result.map_err(|error| {
            let error = match error.downcast::<Interrupted>() {
                Ok(interrupted) => return interrupted.into(),
                Err(error) => error,
            };
            match error.downcast::<Error>() {
                Ok(error @ Error::Configuration(_)) => error,
                Ok(error) => Error::JavaScript(error.to_string()),
                Err(error) => Error::JavaScript(error.to_string()),
            }
        })
    }

    /// Evaluate a prepared invocation expression (see `execution::script`).
    /// JavaScript still running at `deadline` or past the busy timeout
    /// stops with [`Interrupted`](crate::execution::Interrupted): QuickJS
    /// polls, V8's watchdog and the caller's timer terminate the isolate,
    /// and Boa checks at its promise jobs and host calls. The caller's timer
    /// covers time spent outside JavaScript.
    pub(crate) async fn evaluate(
        &mut self,
        expression: String,
        deadline: Option<std::time::Instant>,
    ) -> anyhow::Result<Value> {
        #[cfg(feature = "operation-counts")]
        crate::diagnostics::record("engine.evaluate", expression.len(), 0);
        match self {
            #[cfg(feature = "quickjs")]
            Self::QuickJs(engine) => engine.evaluate_until(expression, deadline).await,
            #[cfg(feature = "boa")]
            Self::Boa(engine) => engine.evaluate_until(expression, deadline).await,
            #[cfg(feature = "v8")]
            Self::V8(engine) => engine.evaluate_until(expression, deadline).await,
        }
    }
}

impl Instance for Engine {
    async fn call_json(&mut self, export: &str, args: &[Value]) -> anyhow::Result<Value> {
        #[cfg(feature = "operation-counts")]
        crate::diagnostics::record("engine.call", export.len(), 0);
        match self {
            #[cfg(feature = "quickjs")]
            Self::QuickJs(engine) => engine.call_json(export, args).await,
            #[cfg(feature = "boa")]
            Self::Boa(engine) => engine.call_json(export, args).await,
            #[cfg(feature = "v8")]
            Self::V8(engine) => engine.call_json(export, args).await,
        }
    }

    fn is_reusable(&self) -> bool {
        match self {
            #[cfg(feature = "quickjs")]
            Self::QuickJs(engine) => engine.is_reusable(),
            #[cfg(feature = "boa")]
            Self::Boa(engine) => engine.is_reusable(),
            #[cfg(feature = "v8")]
            Self::V8(engine) => engine.is_reusable(),
        }
    }
}

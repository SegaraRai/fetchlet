use serde_json::Value;

use super::Backend;
use crate::bridge::HostBridge;
use crate::{Error, Instance, Module, Result};

pub(crate) enum Engine {
    #[cfg(feature = "quickjs")]
    QuickJs(super::QuickJs),
    #[cfg(feature = "boa")]
    Boa(Box<super::Boa>),
    #[cfg(feature = "v8")]
    V8(super::V8),
}

impl Engine {
    pub(crate) fn new(backend: Backend, module: &Module, host: HostBridge) -> Result<Self> {
        let result = match backend {
            #[cfg(feature = "quickjs")]
            Backend::QuickJs(options) => {
                super::QuickJs::with_host(module.source(), host, options).map(Self::QuickJs)
            }
            #[cfg(feature = "boa")]
            Backend::Boa => super::Boa::with_host(module.source(), host)
                .map(|engine| Self::Boa(Box::new(engine))),
            #[cfg(feature = "v8")]
            Backend::V8(options) => {
                super::V8::with_host(module.source(), host, options).map(Self::V8)
            }
        };
        result.map_err(|error| Error::JavaScript(error.to_string()))
    }
}

impl Instance for Engine {
    async fn call_json(&mut self, export: &str, args: &[Value]) -> anyhow::Result<Value> {
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

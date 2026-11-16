use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use super::AppBuilder;
use crate::backend::Engine;
use crate::bridge::HostBridge;
use crate::execution::with_timeout;
use crate::wire::{WireRequest, WireResponse};
use crate::{Backend, Error, HostServices, Instance, Limits, Request, Response, Result};

/// A managed, reusable application instance with fixed host bindings.
///
/// Calls are exclusive (`&mut self`). Keep an App on its owning thread; pool or
/// worker scheduling is left to the Rust application in this release.
pub struct App {
    pub(super) engine: Engine,
    pub(super) host: HostBridge,
    pub(super) limits: Limits,
    pub(super) handler: String,
    pub(super) reusable: bool,
}

impl App {
    pub fn builder(backend: Backend) -> AppBuilder {
        AppBuilder {
            backend,
            module: None,
            hosts: HostServices::default(),
            limits: Limits::default(),
            handler: "handle".into(),
        }
    }

    pub fn is_reusable(&self) -> bool {
        self.reusable && self.engine.is_reusable()
    }

    pub async fn call_json(&mut self, export: &str, args: &[Value]) -> Result<Value> {
        if !self.is_reusable() {
            return Err(Error::InstanceUnavailable);
        }
        let scope = self.host.begin(self.limits.clone())?;
        // This remains false if the caller drops the future at any await point.
        self.reusable = false;
        let result = with_timeout(self.limits.timeout, self.engine.call_json(export, args)).await;
        self.reusable = result.is_ok() && self.engine.is_reusable() && !scope.has_pending();
        drop(scope);
        result?.map_err(|error| Error::JavaScript(error.to_string()))
    }

    /// Call a named function with one Serde argument and deserialize its result.
    pub async fn call<I: Serialize + ?Sized, O: DeserializeOwned>(
        &mut self,
        export: &str,
        input: &I,
    ) -> Result<O> {
        let input = serde_json::to_value(input)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let result = self.call_json(export, &[input]).await?;
        serde_json::from_value(result)
            .map_err(|error| Error::JavaScript(format!("invalid result: {error}")))
    }

    pub async fn fetch(&mut self, request: Request) -> Result<Response> {
        self.fetch_inner(request, None).await
    }

    /// Pass request-scoped metadata as the Fetch entry's second argument.
    pub async fn fetch_with_context<C: Serialize + ?Sized>(
        &mut self,
        request: Request,
        context: &C,
    ) -> Result<Response> {
        let context = serde_json::to_value(context)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        self.fetch_inner(request, Some(context)).await
    }

    async fn fetch_inner(&mut self, request: Request, context: Option<Value>) -> Result<Response> {
        let input = WireRequest::from_http(request, &self.limits)?;
        let input = serde_json::to_value(input)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let handler = self.handler.clone();
        let mut arguments = vec![input];
        if let Some(context) = context {
            arguments.push(context);
        }
        let result = self.call_json(&handler, &arguments).await?;
        let result: WireResponse = serde_json::from_value(result)
            .map_err(|error| Error::JavaScript(format!("invalid Fetch response: {error}")))?;
        result.into_http(&self.limits)
    }
}

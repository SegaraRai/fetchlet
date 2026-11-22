use super::App;
use crate::backend::Engine;
use crate::bridge::HostBridge;
use crate::{AppHandle, Backend, Error, HostServices, Limits, Module, Result};

#[derive(Clone)]
pub struct AppBuilder {
    pub(super) backend: Backend,
    pub(super) module: Option<Module>,
    pub(super) hosts: HostServices,
    pub(super) limits: Limits,
    pub(super) handler: Option<String>,
    /// The identity a worker keeps across the instances it recreates.
    pub(super) key: Option<u64>,
    pub(super) host_runtime: Option<tokio::runtime::Handle>,
}

impl AppBuilder {
    pub fn module(mut self, module: Module) -> Self {
        self.module = Some(module);
        self
    }

    pub fn host_services(mut self, hosts: HostServices) -> Self {
        self.hosts = hosts;
        self
    }

    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// The export that handles Fetch requests, `handle` by default. `None`
    /// builds an application of functions only, whose `fetch` fails with
    /// [`Error::Configuration`] before running any JavaScript; its exports
    /// stay callable with `call` and `call_json`.
    pub fn fetch_handler<'a>(mut self, export: impl Into<Option<&'a str>>) -> Self {
        self.handler = export.into().map(str::to_owned);
        self
    }

    /// Poll host fetches, host bodies and the work they start in the context
    /// of `runtime`.
    ///
    /// By default host futures run in the context of the runtime that drives
    /// the instance: an `AppHandle` worker's own current-thread runtime, or
    /// the caller's for an `App`. On QuickJS and Boa, JavaScript runs on that
    /// runtime's thread, so a task that a transport spawns there, such as the
    /// connection task of a pooled HTTP client, makes progress only while that
    /// instance's JavaScript yields, and another instance that reuses the
    /// connection waits for it. With a host runtime, `tokio::spawn`, timers and
    /// I/O inside host futures use `runtime` instead. It must be driven by
    /// threads of its own, as a multi-thread runtime is, and outlive the
    /// application.
    pub fn host_runtime(mut self, runtime: tokio::runtime::Handle) -> Self {
        self.host_runtime = Some(runtime);
        self
    }

    /// Keep one application identity across the instances a worker builds.
    pub(crate) fn keyed(mut self, key: u64) -> Self {
        self.key = Some(key);
        self
    }

    /// Start an application on its owning worker thread.
    pub async fn spawn(self, options: crate::WorkerOptions) -> Result<AppHandle> {
        let limits = self.limits.clone();
        AppHandle::spawn(self, options, limits).await
    }

    pub fn build(self) -> Result<App> {
        self.limits.validate()?;
        self.backend.validate()?;
        let module = self
            .module
            .ok_or_else(|| Error::Configuration("a module is required".into()))?;
        let mut host = HostBridge::with_limits(self.hosts, self.limits.clone());
        if let Some(key) = self.key {
            host = host.with_key(key);
        }
        if let Some(runtime) = self.host_runtime {
            host = host.with_runtime(runtime);
        }
        let engine = Engine::new(self.backend, &module, host.clone())?;
        Ok(App {
            engine,
            host,
            limits: self.limits,
            handler: self.handler,
            reusable: true,
            background: None,
        })
    }
}

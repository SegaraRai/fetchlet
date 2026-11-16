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
    pub(super) handler: String,
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

    pub fn fetch_handler(mut self, export: impl Into<String>) -> Self {
        self.handler = export.into();
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
        let host = HostBridge::with_limits(self.hosts, self.limits.clone());
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

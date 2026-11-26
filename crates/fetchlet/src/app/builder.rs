use std::sync::Arc;

use super::App;
use crate::backend::{CodeCache, Engine};
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
    /// Compiled code shared by the instances built from this builder and
    /// its clones, for this module.
    pub(super) code_cache: Arc<CodeCache>,
}

impl AppBuilder {
    pub fn module(mut self, module: Module) -> Self {
        self.module = Some(module);
        // Compiled code belongs to the source it came from.
        self.code_cache = Arc::default();
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
        self.backend.validate_limits(&self.limits)?;
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
        let engine = Engine::new(
            self.backend,
            &module,
            host.clone(),
            self.code_cache,
            &self.limits,
        )?;
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{App, Backend, Module};

    const COUNTER: &str = "let count = 0;\
        globalThis.fetchletExports = { next: () => ++count, name: () => 'counter' };";

    /// Backends whose instances share compiled code.
    fn caching_backends() -> Vec<Backend> {
        vec![
            #[cfg(feature = "quickjs")]
            Backend::quickjs(),
            #[cfg(feature = "v8")]
            Backend::v8(),
        ]
    }

    #[tokio::test(flavor = "current_thread")]
    async fn instances_of_one_builder_share_compiled_code_but_not_state() {
        for backend in caching_backends() {
            let builder = App::builder(backend).module(Module::new(COUNTER));
            let mut first = builder.clone().build().unwrap();
            let cached = builder.code_cache.bytes();
            assert!(cached > 0, "{backend:?} cached nothing");
            assert_eq!(first.call_json("next", &[]).await.unwrap(), json!(1));
            assert_eq!(first.call_json("next", &[]).await.unwrap(), json!(2));

            let mut second = builder.clone().build().unwrap();
            assert_eq!(builder.code_cache.bytes(), cached, "{backend:?}");
            assert_eq!(second.call_json("next", &[]).await.unwrap(), json!(1));
            assert_eq!(
                second.call_json("name", &[]).await.unwrap(),
                json!("counter")
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn another_module_compiles_its_own_code() {
        for backend in caching_backends() {
            let builder = App::builder(backend).module(Module::new(COUNTER));
            builder.clone().build().unwrap();
            // Same length as COUNTER, which V8's own check cannot tell apart.
            let other = COUNTER.replace("'counter'", "'another'");
            assert_eq!(other.len(), COUNTER.len());
            let mut app = builder.module(Module::new(other)).build().unwrap();
            assert_eq!(app.call_json("name", &[]).await.unwrap(), json!("another"));
        }
    }

    #[test]
    fn a_module_that_throws_fails_alike_from_compiled_code() {
        for backend in caching_backends() {
            let builder =
                App::builder(backend).module(Module::new("throw new Error('broken at start');"));
            for _ in 0..2 {
                let error = builder.clone().build().err().unwrap().to_string();
                assert!(error.contains("broken at start"), "{backend:?}: {error}");
            }
        }
    }
}

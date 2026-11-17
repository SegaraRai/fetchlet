use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use fetchlet::{Backend, Limits, QuickJsOptions, WorkerOptions};

/// The JavaScript engine. Boa and V8 need the example's cargo feature of the
/// same name, and an artifact built for that backend.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Engine {
    #[default]
    Quickjs,
    Boa,
    V8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub queue_capacity: NonZeroUsize,
    pub request_body_bytes: Option<usize>,
    /// The largest response the protocol buffers for the webview. Tauri's URI
    /// scheme responder takes a complete body, so streamed responses are
    /// collected within this budget.
    pub response_body_bytes: NonZeroUsize,
    pub invocation_timeout_ms: Option<u64>,
    pub background_timeout_ms: Option<u64>,
    pub background_tasks: Option<usize>,
    pub message: String,
    pub build_directory: PathBuf,
    #[serde(default)]
    pub backend: Engine,
    /// The QuickJS stack limit. React-style renderers recurse deeply; HonoX
    /// uses the same value as the axum example.
    pub quickjs_stack_bytes: Option<usize>,
    /// The worker thread's native stack, which must exceed the QuickJS limit.
    pub worker_stack_bytes: Option<NonZeroUsize>,
    /// Boa's value stack in slots, which bounds rendering depth on Boa.
    #[cfg_attr(not(feature = "boa"), allow(dead_code))]
    pub boa_stack_slots: Option<usize>,
    /// Nested JavaScript calls Boa allows.
    #[cfg_attr(not(feature = "boa"), allow(dead_code))]
    pub boa_recursion_limit: Option<usize>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let source = std::fs::read(path)
            .with_context(|| format!("read configuration {}", path.display()))?;
        let mut config: Self = serde_json::from_slice(&source)?;
        if config.build_directory.is_relative() {
            config.build_directory = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(config.build_directory);
        }
        Ok(config)
    }

    pub fn backend(&self) -> Result<Backend> {
        match self.backend {
            Engine::Quickjs => Ok(Backend::QuickJs(QuickJsOptions {
                stack_limit_bytes: self.quickjs_stack_bytes,
                ..QuickJsOptions::default()
            })),
            #[cfg(feature = "boa")]
            Engine::Boa => Ok(Backend::Boa(fetchlet::BoaOptions {
                stack_size_limit: self.boa_stack_slots,
                recursion_limit: self.boa_recursion_limit,
            })),
            #[cfg(feature = "v8")]
            Engine::V8 => Ok(Backend::V8(fetchlet::V8Options {
                worker_stack_bytes: self.worker_stack_bytes.map(NonZeroUsize::get),
            })),
            #[allow(unreachable_patterns)]
            engine => anyhow::bail!("build the app with the {engine:?} feature to use it"),
        }
    }

    pub fn worker_options(&self) -> WorkerOptions {
        let mut options = WorkerOptions::new(self.queue_capacity);
        options.stack_size_bytes = self.worker_stack_bytes;
        options
    }

    pub fn limits(&self) -> Limits {
        Limits {
            timeout: self.invocation_timeout_ms.map(Duration::from_millis),
            request_body_bytes: self.request_body_bytes,
            background_timeout: self.background_timeout_ms.map(Duration::from_millis),
            background_tasks: self.background_tasks,
            ..Limits::default()
        }
    }
}

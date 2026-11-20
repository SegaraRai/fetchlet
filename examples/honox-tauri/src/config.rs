use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use fetchlet::Limits;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    /// Requests queued behind the running one. fetchlet-http's default of 8
    /// when absent.
    pub queue_capacity: Option<NonZeroUsize>,
    pub request_body_bytes: Option<usize>,
    /// The largest response the webview receives. Tauri's URI scheme
    /// responder takes a complete body, so streamed responses are collected
    /// within this budget.
    pub response_body_bytes: NonZeroUsize,
    pub invocation_timeout_ms: Option<u64>,
    pub background_timeout_ms: Option<u64>,
    pub background_tasks: Option<usize>,
    /// The `MESSAGE` binding.
    pub message: String,
    /// The `fetchlet/build` output, relative to the configuration file.
    pub build_directory: PathBuf,
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

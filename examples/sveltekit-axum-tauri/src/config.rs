use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use fetchlet::{Backend, Limits, QuickJsOptions, WorkerOptions};

use crate::workspace::WorkspaceLimits;

/// The JavaScript engine. Boa and V8 need the cargo feature of the same name
/// and an artifact built for that backend.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Engine {
    #[default]
    Quickjs,
    Boa,
    V8,
}

/// Operating policy of one `mdw` installation. Every budget here is the
/// application's choice for a local, single-user notes tool.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    /// Where `mdw serve` listens unless `--listen` overrides it.
    pub listen: SocketAddr,
    pub queue_capacity: NonZeroUsize,
    /// Largest request body the SvelteKit server accepts, such as a saved note.
    pub request_body_bytes: Option<usize>,
    /// Largest response the desktop protocol collects for the webview, which
    /// takes complete bodies.
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub response_body_bytes: NonZeroUsize,
    pub invocation_timeout_ms: Option<u64>,
    /// Largest Markdown file the workspace reads, indexes or writes.
    pub note_bytes: NonZeroUsize,
    /// Largest workspace file `/files` serves, such as an image a note embeds.
    pub file_bytes: NonZeroUsize,
    /// Most notes one workspace indexes; scanning stops with an error beyond it.
    pub workspace_notes: NonZeroUsize,
    /// Quiet period that coalesces a burst of file events into one rescan.
    pub watch_debounce_ms: u64,
    /// A SvelteKit build to serve in place of the one embedded in the binary.
    #[serde(default)]
    pub build_directory: Option<PathBuf>,
    #[serde(default)]
    pub backend: Engine,
    pub quickjs_stack_bytes: Option<usize>,
    /// The worker thread's native stack, which must exceed the QuickJS limit.
    pub worker_stack_bytes: Option<NonZeroUsize>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let source = std::fs::read(path)
            .with_context(|| format!("read configuration {}", path.display()))?;
        let mut config: Self = serde_json::from_slice(&source)
            .with_context(|| format!("parse configuration {}", path.display()))?;
        if let Some(directory) = &mut config.build_directory
            && directory.is_relative()
        {
            *directory = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(&*directory);
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
            Engine::Boa => Ok(Backend::Boa),
            #[cfg(feature = "v8")]
            Engine::V8 => Ok(Backend::V8(fetchlet::V8Options {
                worker_stack_bytes: self.worker_stack_bytes.map(NonZeroUsize::get),
            })),
            #[allow(unreachable_patterns)]
            engine => anyhow::bail!("build mdw with the {engine:?} feature to use it"),
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
            ..Limits::default()
        }
    }

    pub fn workspace_limits(&self) -> WorkspaceLimits {
        WorkspaceLimits {
            note_bytes: self.note_bytes.get(),
            notes: self.workspace_notes.get(),
        }
    }

    pub fn watch_debounce(&self) -> Duration {
        Duration::from_millis(self.watch_debounce_ms)
    }
}

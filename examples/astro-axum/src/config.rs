use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use fetchlet::Limits;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub listen: SocketAddr,
    pub queue_capacity: NonZeroUsize,
    pub request_body_bytes: Option<usize>,
    pub invocation_timeout_ms: Option<u64>,
    pub message: String,
    pub build_directory: PathBuf,
    pub public_origin: Option<String>,
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
            ..Limits::default()
        }
    }
}

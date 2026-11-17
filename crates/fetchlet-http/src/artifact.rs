use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

/// The build output format this crate reads.
const FORMAT: &str = "fetchlet-iife";
const FORMAT_VERSION: u32 = 1;

/// A build output of `fetchlet/build`: `fetchlet.json`, the server module
/// and the optional client assets, in one directory.
///
/// The manifest names the files relative to the directory. Paths that leave
/// the directory are refused, so a manifest cannot point the server at other
/// files.
#[derive(Clone, Debug)]
pub struct Artifact {
    directory: PathBuf,
    manifest: Manifest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    format_version: u32,
    handler: String,
    server: String,
    client: Option<String>,
    backend: Option<String>,
}

/// A failure to read an artifact.
#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
    #[error("could not read {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("invalid manifest {path}: {source}")]
    Manifest {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("unsupported artifact {path}: {reason}")]
    Unsupported { path: PathBuf, reason: String },
}

impl Artifact {
    /// Read `fetchlet.json` in `directory`.
    pub fn open(directory: impl Into<PathBuf>) -> Result<Self, ArtifactError> {
        let directory = directory.into();
        let path = directory.join("fetchlet.json");
        let source = std::fs::read(&path).map_err(|source| ArtifactError::Read {
            path: path.clone(),
            source,
        })?;
        let manifest: Manifest =
            serde_json::from_slice(&source).map_err(|source| ArtifactError::Manifest {
                path: path.clone(),
                source,
            })?;
        let unsupported = |reason: String| ArtifactError::Unsupported {
            path: path.clone(),
            reason,
        };
        if manifest.format != FORMAT || manifest.format_version != FORMAT_VERSION {
            return Err(unsupported(format!(
                "format {} version {}; expected {FORMAT} version {FORMAT_VERSION}",
                manifest.format, manifest.format_version
            )));
        }
        for file in std::iter::once(&manifest.server).chain(&manifest.client) {
            if !is_contained(Path::new(file)) {
                return Err(unsupported(format!("{file} is outside the artifact")));
            }
        }
        Ok(Self {
            directory,
            manifest,
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// The export of the server module that handles Fetch requests.
    pub fn handler(&self) -> &str {
        &self.manifest.handler
    }

    /// The engine the server module was built for, such as `quickjs`.
    pub fn backend(&self) -> Option<&str> {
        self.manifest.backend.as_deref()
    }

    pub fn server_path(&self) -> PathBuf {
        self.directory.join(&self.manifest.server)
    }

    /// The server module's source, for `fetchlet::Module::new`.
    pub fn server_source(&self) -> Result<String, ArtifactError> {
        let path = self.server_path();
        std::fs::read_to_string(&path).map_err(|source| ArtifactError::Read { path, source })
    }

    /// The directory of public client assets, when the framework has any.
    pub fn client_directory(&self) -> Option<PathBuf> {
        self.manifest
            .client
            .as_ref()
            .map(|client| self.directory.join(client))
    }
}

/// Whether a manifest path stays inside the artifact directory.
fn is_contained(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

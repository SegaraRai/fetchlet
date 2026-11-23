use std::borrow::Cow;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use fetchlet::Requirements;
use serde::Deserialize;

use crate::assets::{AssetArchive, AssetArchiveError};

/// The build output format this crate reads.
const FORMAT: &str = "fetchlet-iife";
const FORMAT_VERSION: u32 = 1;

/// A build output of `fetchlet/build`: `fetchlet.json`, the server module
/// and the client assets.
///
/// [`Artifact::open`] reads a directory; the manifest names the files
/// relative to it, and paths that leave it are refused, so a manifest cannot
/// point the server at other files. [`include_artifact!`](crate::include_artifact)
/// embeds the manifest, the server module and the asset archive in the
/// binary instead. An asset archive is read and checked when the artifact is
/// created.
#[derive(Clone, Debug)]
pub struct Artifact {
    source: Source,
    manifest: Manifest,
    assets: Option<Arc<AssetArchive>>,
}

#[derive(Clone, Debug)]
enum Source {
    Directory(PathBuf),
    Embedded { server: Cow<'static, str> },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    format_version: u32,
    handler: Option<String>,
    functions: Option<Vec<String>>,
    server: String,
    client: Option<String>,
    assets: Option<String>,
    backend: Option<String>,
    /// What the artifact needs from its host, from builds that record it.
    needs: Option<Needs>,
    /// The fields older builds derive needs from.
    #[serde(default)]
    native_requirements: Vec<String>,
    intl: Option<Intl>,
    async_context: Option<String>,
}

/// `needs` in the manifest: the assumptions the build made about the host.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Needs {
    engine_apis: Vec<String>,
    locales: Vec<String>,
    async_context: bool,
    host_apis: Vec<String>,
    host_protocol: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct Intl {
    locales: Vec<String>,
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
    #[error("invalid asset archive {path}: {source}")]
    Assets {
        path: PathBuf,
        source: AssetArchiveError,
    },
}

/// The path errors name for an embedded artifact.
const EMBEDDED: &str = "<embedded>";

impl Artifact {
    /// Read `fetchlet.json` in `directory`.
    pub fn open(directory: impl Into<PathBuf>) -> Result<Self, ArtifactError> {
        let directory = directory.into();
        let path = directory.join("fetchlet.json");
        let source = std::fs::read(&path).map_err(|source| ArtifactError::Read {
            path: path.clone(),
            source,
        })?;
        let manifest = parse_manifest(&source, &path)?;
        let assets = match &manifest.assets {
            Some(file) => {
                let path = directory.join(file);
                let archive = AssetArchive::open(&path)
                    .map_err(|source| ArtifactError::Assets { path, source })?;
                Some(Arc::new(archive))
            }
            None => None,
        };
        Ok(Self {
            source: Source::Directory(directory),
            manifest,
            assets,
        })
    }

    /// An artifact whose files are in memory, usually through
    /// [`include_artifact!`](crate::include_artifact). `assets` is required
    /// when the manifest names an asset archive. Embedded artifacts have no
    /// client directory.
    pub fn embedded(
        manifest: &[u8],
        server: impl Into<Cow<'static, str>>,
        assets: Option<Bytes>,
    ) -> Result<Self, ArtifactError> {
        let path = Path::new(EMBEDDED).join("fetchlet.json");
        let manifest = parse_manifest(manifest, &path)?;
        let assets = match (&manifest.assets, assets) {
            (Some(file), Some(bytes)) => {
                let archive = AssetArchive::new(bytes).map_err(|source| ArtifactError::Assets {
                    path: Path::new(EMBEDDED).join(file),
                    source,
                })?;
                Some(Arc::new(archive))
            }
            (Some(file), None) => {
                return Err(ArtifactError::Unsupported {
                    path,
                    reason: format!("the manifest names {file}, which was not embedded"),
                });
            }
            (None, _) => None,
        };
        Ok(Self {
            source: Source::Embedded {
                server: server.into(),
            },
            manifest,
            assets,
        })
    }

    /// The artifact directory, for an artifact read with [`Artifact::open`].
    pub fn directory(&self) -> Option<&Path> {
        match &self.source {
            Source::Directory(directory) => Some(directory),
            Source::Embedded { .. } => None,
        }
    }

    /// The export of the server module that handles Fetch requests, for
    /// `AppBuilder::fetch_handler`. `None` for an artifact of functions only,
    /// whose App refuses `fetch` and serves `call`.
    pub fn handler(&self) -> Option<&str> {
        self.manifest.handler.as_deref()
    }

    /// The functions the server module exports for `App::call`, when the
    /// manifest records them.
    pub fn functions(&self) -> Option<&[String]> {
        self.manifest.functions.as_deref()
    }

    /// The engine the server module was built for, such as `quickjs`.
    pub fn backend(&self) -> Option<&str> {
        self.manifest.backend.as_deref()
    }

    /// What the server module needs from the host that runs it, for
    /// `fetchlet::Module::requires`: the engine APIs the build left to the
    /// engine and their locales, the engine's async context, and the Web
    /// APIs and protocol of fetchlet-web. Building an App with them refuses
    /// a host that lacks one before the module runs.
    ///
    /// ```ignore
    /// let module = Module::new(artifact.server_source()?).requires(artifact.requirements());
    /// ```
    ///
    /// For a manifest without `needs`, they come from `nativeRequirements`,
    /// `intl.locales` and `asyncContext`.
    pub fn requirements(&self) -> Requirements {
        let manifest = &self.manifest;
        let needs = match &manifest.needs {
            Some(needs) => needs.clone(),
            None => Needs {
                engine_apis: manifest.native_requirements.clone(),
                locales: manifest
                    .intl
                    .as_ref()
                    .map(|intl| intl.locales.clone())
                    .unwrap_or_default(),
                async_context: manifest.async_context.as_deref() == Some("propagated"),
                ..Needs::default()
            },
        };
        let mut requirements = Requirements::new().locales(needs.locales);
        for api in needs.engine_apis {
            requirements = requirements.engine_api(api);
        }
        if needs.async_context {
            requirements = requirements.async_context();
        }
        for api in needs.host_apis {
            requirements = requirements.host_api(api);
        }
        if let Some(version) = needs.host_protocol {
            requirements = requirements.host_protocol(version);
        }
        requirements
    }

    /// The server module's file, for an artifact read from a directory.
    pub fn server_path(&self) -> Option<PathBuf> {
        self.directory()
            .map(|directory| directory.join(&self.manifest.server))
    }

    /// The server module's source, for `fetchlet::Module::new`.
    pub fn server_source(&self) -> Result<String, ArtifactError> {
        match &self.source {
            Source::Directory(directory) => {
                let path = directory.join(&self.manifest.server);
                std::fs::read_to_string(&path)
                    .map_err(|source| ArtifactError::Read { path, source })
            }
            Source::Embedded { server } => Ok(server.clone().into_owned()),
        }
    }

    /// The directory of public client assets, when the framework has any and
    /// the artifact was read from a directory.
    pub fn client_directory(&self) -> Option<PathBuf> {
        let client = self.manifest.client.as_ref()?;
        self.directory().map(|directory| directory.join(client))
    }

    /// The client assets packed by `archiveArtifactAssets`, when the
    /// manifest names an archive.
    pub fn asset_archive(&self) -> Option<&Arc<AssetArchive>> {
        self.assets.as_ref()
    }
}

fn parse_manifest(source: &[u8], path: &Path) -> Result<Manifest, ArtifactError> {
    let manifest: Manifest =
        serde_json::from_slice(source).map_err(|source| ArtifactError::Manifest {
            path: path.to_owned(),
            source,
        })?;
    let unsupported = |reason: String| ArtifactError::Unsupported {
        path: path.to_owned(),
        reason,
    };
    if manifest.format != FORMAT || manifest.format_version != FORMAT_VERSION {
        return Err(unsupported(format!(
            "format {} version {}; expected {FORMAT} version {FORMAT_VERSION}",
            manifest.format, manifest.format_version
        )));
    }
    for file in std::iter::once(&manifest.server)
        .chain(&manifest.client)
        .chain(&manifest.assets)
    {
        if !is_contained(Path::new(file)) {
            return Err(unsupported(format!("{file} is outside the artifact")));
        }
    }
    Ok(manifest)
}

/// Whether a manifest path stays inside the artifact directory.
fn is_contained(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Embed the artifact in `$directory` in the binary: its `fetchlet.json`,
/// `server.js` and `assets.flpk`, which `fetchlet/build` writes with
/// `archiveArtifactAssets`. `$directory` is a string literal or a macro such
/// as `concat!` or `env!` that expands to one, and is resolved as
/// `include_bytes!` resolves paths, relative to the file that calls it.
///
/// ```ignore
/// let artifact = fetchlet_http::include_artifact!(env!("APP_ARTIFACT"))?;
/// ```
#[macro_export]
macro_rules! include_artifact {
    ($directory:expr) => {
        $crate::Artifact::embedded(
            ::core::include_bytes!(::core::concat!($directory, "/fetchlet.json")),
            ::core::include_str!(::core::concat!($directory, "/server.js")),
            ::core::option::Option::Some($crate::__private::Bytes::from_static(
                ::core::include_bytes!(::core::concat!($directory, "/assets.flpk")),
            )),
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(fields: &str) -> Vec<u8> {
        format!(r#"{{"format":"fetchlet-iife","formatVersion":1,"handler":"handle",{fields}}}"#)
            .into_bytes()
    }

    fn reason(source: &[u8]) -> String {
        match parse_manifest(source, Path::new("fetchlet.json")) {
            Err(ArtifactError::Unsupported { reason, .. }) => reason,
            other => panic!("expected an unsupported manifest, got {other:?}"),
        }
    }

    #[test]
    fn manifest_paths_stay_inside_the_artifact() {
        for path in ["server.js", "./server.js", "nested/server.js", "a/./b"] {
            assert!(is_contained(Path::new(path)), "{path}");
        }
        for path in ["../server.js", "a/../b", "/server.js"] {
            assert!(!is_contained(Path::new(path)), "{path}");
        }
        #[cfg(windows)]
        for path in [r"C:\server.js", r"\\host\share\server.js", r"C:server.js"] {
            assert!(!is_contained(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn every_named_file_is_checked() {
        assert_eq!(
            reason(&manifest(
                r#""server":"server.js","assets":"../assets.flpk""#
            )),
            "../assets.flpk is outside the artifact"
        );
        assert_eq!(
            reason(&manifest(r#""server":"server.js","client":"/srv/public""#)),
            "/srv/public is outside the artifact"
        );
    }

    #[test]
    fn the_format_and_its_version_must_match() {
        let other = br#"{"format":"esm","formatVersion":1,"handler":"handle","server":"s.js"}"#;
        assert_eq!(
            reason(other),
            "format esm version 1; expected fetchlet-iife version 1"
        );
    }

    #[test]
    fn required_fields_are_checked_and_optional_ones_may_be_absent() {
        assert!(matches!(
            parse_manifest(
                &manifest(r#""client":"client""#),
                Path::new("fetchlet.json")
            ),
            Err(ArtifactError::Manifest { .. })
        ));
        let parsed = parse_manifest(
            &manifest(r#""server":"server.js","framework":"astro""#),
            Path::new("fetchlet.json"),
        )
        .unwrap();
        assert_eq!(parsed.server, "server.js");
        assert!(parsed.client.is_none() && parsed.assets.is_none() && parsed.backend.is_none());
    }

    #[test]
    fn an_artifact_of_functions_only_has_no_handler() {
        let source = br#"{"format":"fetchlet-iife","formatVersion":1,"handler":null,"functions":["greet"],"server":"server.js"}"#;
        let artifact = Artifact::embedded(source, "", None).unwrap();
        assert_eq!(artifact.handler(), None);
        assert_eq!(artifact.functions(), Some(&["greet".to_owned()][..]));
        let older = Artifact::embedded(&manifest(r#""server":"server.js""#), "", None).unwrap();
        assert_eq!(older.handler(), Some("handle"));
        assert_eq!(older.functions(), None);
    }

    fn requirements(fields: &str) -> Requirements {
        Artifact::embedded(
            &manifest(&format!(r#""server":"server.js"{fields}"#)),
            "",
            None,
        )
        .unwrap()
        .requirements()
    }

    #[test]
    fn requirements_come_from_needs_or_the_older_fields() {
        assert!(requirements("").is_empty());
        assert_eq!(
            requirements(
                r#","nativeRequirements":["Intl.DateTimeFormat"],"intl":{"locales":["en","ja"],"timeZoneData":"utc"},"asyncContext":"propagated""#
            ),
            Requirements::new()
                .engine_api("Intl.DateTimeFormat")
                .locales(["en", "ja"])
                .async_context()
        );
        assert!(requirements(r#","nativeRequirements":[],"asyncContext":"serialized""#).is_empty());
        // needs, when present, is the whole answer.
        assert_eq!(
            requirements(
                r#","nativeRequirements":["Intl.Locale"],"needs":{"engineApis":["Intl.NumberFormat"],"locales":["en"],"asyncContext":false,"hostApis":["crypto"],"hostProtocol":3}"#
            ),
            Requirements::new()
                .engine_api("Intl.NumberFormat")
                .locales(["en"])
                .host_api("crypto")
                .host_protocol(3)
        );
    }

    #[test]
    fn an_embedded_artifact_needs_the_archive_its_manifest_names() {
        let source = manifest(r#""server":"server.js","assets":"assets.flpk""#);
        match Artifact::embedded(&source, "export const handle = 1;", None) {
            Err(ArtifactError::Unsupported { reason, .. }) => {
                assert_eq!(
                    reason,
                    "the manifest names assets.flpk, which was not embedded"
                );
            }
            other => panic!("expected a missing archive, got {other:?}"),
        }
        let artifact = Artifact::embedded(
            &manifest(r#""server":"server.js","client":"client""#),
            "export const handle = 1;",
            Some(Bytes::from_static(b"ignored without a manifest entry")),
        )
        .unwrap();
        assert!(artifact.asset_archive().is_none());
        assert!(artifact.directory().is_none());
        assert!(artifact.client_directory().is_none());
        assert!(artifact.server_path().is_none());
        assert_eq!(
            artifact.server_source().unwrap(),
            "export const handle = 1;"
        );
    }
}

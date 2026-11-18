use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::routing::get;
use notify::RecommendedWatcher;

use fetchlet::{App, AppHandle, HostServices, Module, OriginRouter};
use fetchlet_http::{Artifact, AxumService, artifact_router, router_transport};

use crate::api::{ApiState, FileState, Highlighter, api_router, public_api_router, workspace_file};
use crate::config::Config;
use crate::workspace::{Workspace, watch};

/// The origin that names the in-process Rust API for server-side JavaScript.
/// It resolves nowhere on the network; the fetch policy routes it to the API
/// router inside this process and admits no other origin.
pub(crate) const RUST_ORIGIN: &str = "https://fetchlet.internal";

/// Where the pages are shown. Server-side JavaScript reads it as `MDW_SHELL`.
#[derive(Clone, Copy)]
pub(crate) enum Shell {
    Browser,
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    Desktop,
}

impl Shell {
    fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Desktop => "desktop",
        }
    }
}

/// The parts both shells share: the workspace and its watcher, the API, and
/// the fetchlet application that runs the SvelteKit server.
pub(crate) struct Host {
    pub app: AppHandle,
    pub state: ApiState,
    note_bytes: usize,
    file_bytes: usize,
    artifact: Artifact,
    _watcher: RecommendedWatcher,
}

impl Host {
    pub async fn start(config: &Config, workspace_directory: &Path, shell: Shell) -> Result<Self> {
        let artifact = frontend(config)?;
        let workspace = Arc::new(Workspace::open(
            workspace_directory,
            config.workspace_limits(),
        )?);
        let watcher = watch(workspace.clone(), config.watch_debounce())?;
        let highlighter = Arc::new(Highlighter::new());
        // Loading the grammars takes a moment; do it before the first page needs them.
        std::thread::spawn({
            let highlighter = highlighter.clone();
            move || highlighter.warm_up()
        });
        let state = ApiState {
            workspace,
            highlighter,
        };
        let note_bytes = config.note_bytes.get();

        let api = OriginRouter::new()
            .internal(
                RUST_ORIGIN,
                router_transport(api_router(state.clone(), note_bytes)),
            )?
            .into_service();
        let hosts = HostServices::new()
            .outbound(api)
            // SvelteKit reports server errors with console.error.
            .console(|level, message| eprintln!("[js {level:?}] {message}"))
            .env("MDW_SHELL", shell.as_str())?;
        let app = App::builder(config.backend()?)
            .module(Module::new(artifact.server_source()?))
            .fetch_handler(artifact.handler())
            .host_services(hosts)
            .limits(config.limits())
            .spawn(config.worker_options())
            .await?;
        Ok(Self {
            app,
            state,
            note_bytes,
            file_bytes: config.file_bytes.get(),
            artifact,
            _watcher: watcher,
        })
    }

    /// The whole application as one router: the public API, workspace files,
    /// the client build, and the SvelteKit pages for everything else. The CLI
    /// serves it over HTTP and the desktop window through a URI scheme.
    pub fn router(&self, public_origin: &str) -> Result<Router> {
        let pages = AxumService::new(self.app.clone(), public_origin)?
            .on_error(|error| eprintln!("request failed: {error:#}"));
        let files = Router::new()
            .route("/{*path}", get(workspace_file))
            .with_state(FileState {
                api: self.state.clone(),
                file_bytes: self.file_bytes,
            });
        Ok(Router::new()
            .nest(
                "/api/v1",
                public_api_router(self.state.clone(), self.note_bytes),
            )
            .nest("/files", files)
            .merge(artifact_router(&self.artifact, pages)))
    }

    pub async fn shutdown(self) -> Result<()> {
        self.app.shutdown().await?;
        Ok(())
    }
}

/// The SvelteKit build: from `build_directory` when the configuration names
/// one, otherwise the copy embedded in this binary.
fn frontend(config: &Config) -> Result<Artifact> {
    if let Some(directory) = &config.build_directory {
        return Artifact::open(directory)
            .with_context(|| format!("read the SvelteKit build in {}", directory.display()));
    }
    #[cfg(mdw_embedded)]
    {
        Ok(fetchlet_http::include_artifact!(env!("MDW_FRONTEND"))?)
    }
    #[cfg(not(mdw_embedded))]
    {
        anyhow::bail!(
            "this mdw was built without the SvelteKit frontend: run `vp run build` before building mdw, or set build_directory"
        )
    }
}

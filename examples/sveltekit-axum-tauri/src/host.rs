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
/// the pages the fetchlet application renders from the SvelteKit build.
pub(crate) struct Host {
    pub state: ApiState,
    pages: Pages,
    _watcher: RecommendedWatcher,
}

impl Host {
    /// Start the workspace and the application. `public_origin` is the
    /// origin pages are served at, which SvelteKit sees in each request.
    pub async fn start(
        config: Arc<Config>,
        workspace_directory: &Path,
        shell: Shell,
        public_origin: &str,
    ) -> Result<Self> {
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
        let site = Site {
            config,
            state: state.clone(),
            shell,
            public_origin: public_origin.to_owned(),
        };
        let pages = Pages::start(site).await?;
        Ok(Self {
            state,
            pages,
            _watcher: watcher,
        })
    }

    /// The whole application as one router: the public API, workspace files,
    /// the client build, and the SvelteKit pages for everything else. The CLI
    /// serves it over HTTP. With the `dev` feature it serves each build the
    /// `dev` task writes and reloads the browser pages that show one.
    pub fn router(&self) -> Router {
        self.pages.router()
    }

    /// The router of the build that serves the next request, for the
    /// desktop window, which reloads itself on a new build.
    #[cfg(feature = "desktop")]
    pub fn current(&self) -> Router {
        self.pages.current()
    }

    /// Each new build from now on.
    #[cfg(all(feature = "desktop", feature = "dev"))]
    pub fn reloads(&self) -> fetchlet_http::Reloads {
        self.pages.reload.reloads()
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.pages.shutdown().await
    }
}

/// What one build's router needs besides the build.
struct Site {
    config: Arc<Config>,
    state: ApiState,
    shell: Shell,
    public_origin: String,
}

impl Site {
    /// The router of `artifact` and the application that renders its pages.
    async fn build(&self, artifact: &Artifact) -> Result<(Router, AppHandle)> {
        let config = &self.config;
        let note_bytes = config.note_bytes.get();
        let api = OriginRouter::new()
            .internal(
                RUST_ORIGIN,
                router_transport(api_router(self.state.clone(), note_bytes)),
            )?
            .into_service();
        let hosts = HostServices::new()
            .outbound(api)
            // SvelteKit reports server errors with console.error.
            .console(|level, message| eprintln!("[js {level:?}] {message}"))
            .env("MDW_SHELL", self.shell.as_str())?;
        let app = App::builder(config.backend()?)
            .module(Module::new(artifact.server_source()?))
            .fetch_handler(artifact.handler())
            .host_services(hosts)
            .limits(config.limits())
            .spawn(config.worker_options())
            .await?;
        let pages = AxumService::new(app.clone(), &self.public_origin)?
            .on_error(|error| eprintln!("request failed: {error:#}"));
        let files = Router::new()
            .route("/{*path}", get(workspace_file))
            .with_state(FileState {
                api: self.state.clone(),
                file_bytes: config.file_bytes.get(),
            });
        let router = Router::new()
            .nest("/api/v1", public_api_router(self.state.clone(), note_bytes))
            .nest("/files", files)
            .merge(artifact_router(artifact, pages));
        Ok((router, app))
    }
}

/// The pages of one build, or with the `dev` feature of each build the `dev`
/// task writes to the build directory.
struct Pages {
    #[cfg(not(feature = "dev"))]
    router: Router,
    #[cfg(not(feature = "dev"))]
    app: AppHandle,
    #[cfg(feature = "dev")]
    reload: fetchlet_http::DevReload<Router>,
}

impl Pages {
    #[cfg(not(feature = "dev"))]
    async fn start(site: Site) -> Result<Self> {
        let artifact = frontend(&site.config)?;
        let (router, app) = site.build(&artifact).await?;
        Ok(Self { router, app })
    }

    #[cfg(feature = "dev")]
    async fn start(site: Site) -> Result<Self> {
        use fetchlet_http::{DevReload, Generation};

        // Development serves the build directory, never the embedded copy.
        let directory = site
            .config
            .build_directory
            .clone()
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("build"));
        let site = Arc::new(site);
        let reload = DevReload::watch(directory)
            .start(move |artifact| {
                let site = site.clone();
                async move {
                    let (router, app) = site.build(&artifact).await?;
                    anyhow::Ok(Generation::new(router).with_app(app))
                }
            })
            .await
            .context("run `vp run build` before starting mdw with the dev feature")?;
        Ok(Self { reload })
    }

    fn router(&self) -> Router {
        #[cfg(not(feature = "dev"))]
        return self.router.clone();
        #[cfg(feature = "dev")]
        return Router::new().fallback_service(self.reload.service());
    }

    #[cfg(feature = "desktop")]
    fn current(&self) -> Router {
        #[cfg(not(feature = "dev"))]
        return self.router.clone();
        #[cfg(feature = "dev")]
        return self.reload.current();
    }

    async fn shutdown(&self) -> Result<()> {
        #[cfg(not(feature = "dev"))]
        self.app.shutdown().await?;
        #[cfg(feature = "dev")]
        self.reload.shutdown().await?;
        Ok(())
    }
}

/// The SvelteKit build: from `build_directory` when the configuration names
/// one, otherwise the copy embedded in this binary.
#[cfg(not(feature = "dev"))]
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

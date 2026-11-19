use std::future::Future;
use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use tokio::net::TcpListener;

use fetchlet::{App, AppHandle, Backend, HostServices, Limits, Module, WorkerOptions};

use super::{AxumService, artifact_router};
use crate::{Artifact, ArtifactError};

/// Commands a server's application queues behind the running call by
/// default: a caller policy that bounds the requests waiting for one engine
/// thread before they are refused.
const DEFAULT_QUEUE_CAPACITY: NonZeroUsize = NonZeroUsize::new(8).unwrap();

/// The worker thread's native stack by default. Framework server renderers
/// recurse deeply, and Boa and V8 evaluate on this stack; 8 MiB is what the
/// repository's framework examples need on every engine.
const DEFAULT_WORKER_STACK_BYTES: NonZeroUsize = NonZeroUsize::new(8 * 1024 * 1024).unwrap();

/// QuickJS's stack limit by default, within the worker stack above. React's
/// server renderer retries an element after a stack overflow and can leave a
/// partial tag behind, so the limit leaves it room.
const DEFAULT_QUICKJS_STACK_BYTES: usize = 4 * 1024 * 1024;

/// Boa's value stack limit by default, in slots. React Server Components
/// rendering on Boa, as in the vinext example, needs this depth.
const DEFAULT_BOA_STACK_SLOTS: usize = 128 * 1024;

/// The environment variable that names a Vite dev server to run from, read
/// when the `vite-dev` feature is enabled.
pub const VITE_URL_VARIABLE: &str = "FETCHLET_VITE_URL";

type ServicesFn = dyn Fn() -> fetchlet::Result<HostServices> + Send + Sync;
type RenderingFn = dyn Fn(AxumService) -> AxumService + Send + Sync;
type RoutesFn = dyn Fn(&AppHandle) -> Router + Send + Sync;

/// A failure to start serving.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ServerError {
    #[error(
        "could not open the build in {directory}: {source}; build the frontend before starting the server"
    )]
    Artifact {
        directory: PathBuf,
        source: ArtifactError,
    },
    #[error("could not start the application: {0}")]
    App(#[from] fetchlet::Error),
    #[error("invalid public origin: {0}")]
    PublicOrigin(#[from] crate::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[cfg(feature = "dev")]
    #[error(transparent)]
    Reload(#[from] crate::ReloadError),
    #[cfg(feature = "vite-dev")]
    #[error("could not run from the Vite dev server at {url}: {source}")]
    Vite {
        url: String,
        source: crate::ViteDevError,
    },
}

/// An axum server for one `fetchlet/build` artifact: Rust routes first, then
/// the artifact's client assets, then the application.
///
/// ```rust,ignore
/// let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
/// Server::new("build")
///     .host_services(|| HostServices::new().env("MESSAGE", "Hello"))
///     .routes(|_app| Router::new().route("/api/rust", get(rust_endpoint)))
///     .serve(listener)
///     .await?;
/// ```
///
/// The engine is the one the artifact was built for. How the build is
/// served follows the crate's features:
///
/// - With `vite-dev` and [`VITE_URL_VARIABLE`] set, the server module runs
///   from that Vite dev server through [`ViteDev`](crate::ViteDev), which
///   also serves the browser modules, and console output goes to standard
///   error.
/// - Otherwise, with `dev`, [`DevReload`](crate::DevReload) serves each build
///   written to the directory and reloads open pages.
/// - Otherwise the build is opened once.
///
/// Keep `dev` and `vite-dev` out of release builds.
pub struct Server {
    directory: PathBuf,
    backend: Option<Backend>,
    services: Arc<ServicesFn>,
    routes: Arc<RoutesFn>,
    limits: Limits,
    worker: Option<WorkerOptions>,
    queue_capacity: Option<NonZeroUsize>,
    public_origin: Option<String>,
    rendering: Arc<RenderingFn>,
}

impl Server {
    /// A server for the artifact in `directory`, the output directory of
    /// `fetchlet/build`. A relative path is resolved against the working
    /// directory.
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            backend: None,
            services: Arc::new(|| Ok(HostServices::new())),
            routes: Arc::new(|_| Router::new()),
            limits: Limits::default(),
            worker: None,
            queue_capacity: None,
            public_origin: None,
            rendering: Arc::new(|service| service),
        }
    }

    /// The engine and its options. By default, the engine the artifact was
    /// built for, through [`Backend::for_target`]. While the worker keeps its
    /// default stack, QuickJS gets a 4 MiB stack limit and Boa a value stack
    /// of 131,072 slots, the depth framework server renderers need.
    pub fn backend(mut self, backend: Backend) -> Self {
        self.backend = Some(backend);
        self
    }

    /// The host services, made once for each application the server starts:
    /// one, or one per build under `dev`.
    pub fn host_services(
        mut self,
        services: impl Fn() -> fetchlet::Result<HostServices> + Send + Sync + 'static,
    ) -> Self {
        self.services = Arc::new(services);
        self
    }

    /// Rust routes, which answer before the artifact's assets and the
    /// application. They are made for each application the server starts,
    /// whose handle they receive, so a route can call the module's named
    /// exports with [`AppHandle::call_json`].
    pub fn routes(mut self, routes: impl Fn(&AppHandle) -> Router + Send + Sync + 'static) -> Self {
        self.routes = Arc::new(routes);
        self
    }

    /// The application's caller budgets. [`Limits::default`] by default.
    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// The application's worker thread. By default, a queue of 8 commands
    /// and an 8 MiB native stack.
    pub fn worker(mut self, worker: WorkerOptions) -> Self {
        self.worker = Some(worker);
        self
    }

    /// Commands queued behind the running call, keeping the rest of the
    /// worker options. 8 by default.
    pub fn queue_capacity(mut self, capacity: NonZeroUsize) -> Self {
        self.queue_capacity = Some(capacity);
        self
    }

    /// The origin the application sees in request URLs, such as the one a
    /// proxy serves it under. By default, `http://` and the listener's
    /// address.
    pub fn public_origin(mut self, origin: impl Into<String>) -> Self {
        self.public_origin = Some(origin.into());
        self
    }

    /// Adjust the service that passes requests to the application, such as
    /// with [`AxumService::stream_request_bodies`] or
    /// [`AxumService::trusted_context`]. Errors are written to standard
    /// error before this runs.
    pub fn rendering(
        mut self,
        configure: impl Fn(AxumService) -> AxumService + Send + Sync + 'static,
    ) -> Self {
        self.rendering = Arc::new(configure);
        self
    }

    /// Serve on `listener` until Ctrl-C, then shut the application down.
    pub async fn serve(self, listener: TcpListener) -> Result<(), ServerError> {
        self.serve_with_shutdown(listener, async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                eprintln!("fetchlet: could not listen for Ctrl-C: {error}");
                std::future::pending::<()>().await;
            }
        })
        .await
    }

    /// Serve on `listener` until `signal` completes, finish the requests in
    /// progress, then shut the application down.
    pub async fn serve_with_shutdown(
        self,
        listener: TcpListener,
        signal: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), ServerError> {
        let origin = match &self.public_origin {
            Some(origin) => origin.clone(),
            None => format!("http://{}", listener.local_addr()?),
        };
        let settings = Arc::new(Settings {
            backend: self.backend,
            routes: self.routes,
            limits: self.limits,
            worker: self.worker,
            queue_capacity: self.queue_capacity,
            origin,
            rendering: self.rendering,
        });

        #[cfg(feature = "vite-dev")]
        if let Ok(url) = std::env::var(VITE_URL_VARIABLE) {
            return serve_vite(listener, signal, &settings, &self.services, &url).await;
        }

        #[cfg(feature = "dev")]
        return serve_reloading(listener, signal, settings, self.services, self.directory).await;

        #[cfg(not(feature = "dev"))]
        {
            let artifact = open(&self.directory)?;
            let (router, app) = settings.application(&artifact, (self.services)()?).await?;
            let result = run(listener, router, signal).await;
            app.shutdown().await?;
            result
        }
    }
}

/// What every application of one server shares.
struct Settings {
    backend: Option<Backend>,
    routes: Arc<RoutesFn>,
    limits: Limits,
    worker: Option<WorkerOptions>,
    queue_capacity: Option<NonZeroUsize>,
    origin: String,
    rendering: Arc<RenderingFn>,
}

impl Settings {
    /// Start the application for `artifact` and route to it.
    async fn application(
        &self,
        artifact: &Artifact,
        services: HostServices,
    ) -> Result<(Router, AppHandle), ServerError> {
        let mut worker = self.worker.clone().unwrap_or_else(|| {
            let mut worker = WorkerOptions::new(DEFAULT_QUEUE_CAPACITY);
            worker.stack_size_bytes = Some(DEFAULT_WORKER_STACK_BYTES);
            worker
        });
        if let Some(capacity) = self.queue_capacity {
            worker.queue_capacity = capacity;
        }
        let backend = match self.backend {
            Some(backend) => backend,
            None => default_backend(artifact, &worker)?,
        };
        let app = App::builder(backend)
            .module(Module::new(artifact.server_source().map_err(|source| {
                ServerError::Artifact {
                    directory: artifact.directory().map(PathBuf::from).unwrap_or_default(),
                    source,
                }
            })?))
            .fetch_handler(artifact.handler())
            .host_services(services)
            .limits(self.limits.clone())
            .spawn(worker)
            .await?;
        let rendering = AxumService::new(app.clone(), &self.origin)?
            .on_error(|error| eprintln!("fetchlet: request failed: {error:#}"));
        let rendering = (self.rendering)(rendering);
        let router = (self.routes)(&app).merge(artifact_router(artifact, rendering));
        Ok((router, app))
    }
}

/// The artifact's own engine, with QuickJS and Boa stack limits that fit
/// the default worker stack.
fn default_backend(artifact: &Artifact, worker: &WorkerOptions) -> Result<Backend, ServerError> {
    let backend = Backend::for_target(artifact.backend().unwrap_or("portable"))?;
    if worker.stack_size_bytes >= Some(DEFAULT_WORKER_STACK_BYTES) {
        return Ok(backend
            .with_default_quickjs_stack(DEFAULT_QUICKJS_STACK_BYTES)
            .with_default_boa_stack(DEFAULT_BOA_STACK_SLOTS));
    }
    Ok(backend)
}

#[cfg(not(feature = "dev"))]
fn open(directory: &std::path::Path) -> Result<Artifact, ServerError> {
    Artifact::open(directory).map_err(|source| ServerError::Artifact {
        directory: directory.to_path_buf(),
        source,
    })
}

async fn run(
    listener: TcpListener,
    router: Router,
    signal: impl Future<Output = ()> + Send + 'static,
) -> Result<(), ServerError> {
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(signal)
    .await?;
    Ok(())
}

/// Serve each build written to `directory`.
#[cfg(feature = "dev")]
async fn serve_reloading(
    listener: TcpListener,
    signal: impl Future<Output = ()> + Send + 'static,
    settings: Arc<Settings>,
    services: Arc<ServicesFn>,
    directory: PathBuf,
) -> Result<(), ServerError> {
    use crate::{DevReload, Generation, ReloadError};

    let reload = DevReload::watch(directory.clone())
        .start(move |artifact| {
            let (settings, services) = (settings.clone(), services.clone());
            async move {
                let (router, app) = settings.application(&artifact, services()?).await?;
                Ok::<_, ServerError>(Generation::new(router).with_app(app))
            }
        })
        .await
        .map_err(|error| match error {
            ReloadError::Artifact(source) => ServerError::Artifact { directory, source },
            error => ServerError::Reload(error),
        })?;
    let result = run(
        listener,
        Router::new().fallback_service(reload.service()),
        signal,
    )
    .await;
    reload.shutdown().await?;
    result
}

/// Run the server module from the Vite dev server at `url`.
#[cfg(feature = "vite-dev")]
async fn serve_vite(
    listener: TcpListener,
    signal: impl Future<Output = ()> + Send + 'static,
    settings: &Settings,
    services: &Arc<ServicesFn>,
    url: &str,
) -> Result<(), ServerError> {
    use crate::ViteDev;

    let failed = |source| ServerError::Vite {
        url: url.into(),
        source,
    };
    let vite = ViteDev::new(url).map_err(failed)?;
    let artifact = vite.artifact().await.map_err(failed)?;
    // Development shows what the server module logs.
    let services = vite
        .host_services(services()?)?
        .console(|level, message| eprintln!("[{level:?}] {message}"));
    let (router, app) = settings.application(&artifact, services).await?;
    let result = run(
        listener,
        Router::new().fallback_service(vite.proxy(router)),
        signal,
    )
    .await;
    app.shutdown().await?;
    result
}

use std::future::Future;
use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use tokio::net::TcpListener;

use fetchlet::{
    App, AppHandle, Backend, CancelledCalls, HostServices, Instances, Limits, Module, WorkerOptions,
};

use super::{AxumService, artifact_router};
use crate::artifact::{
    DEFAULT_BOA_RECURSION, DEFAULT_BOA_STACK_SLOTS, DEFAULT_HEAP_BYTES,
    DEFAULT_QUICKJS_STACK_BYTES, MINIMUM_STACK_FOR_DEFAULT_LIMITS,
};
use crate::{Artifact, ArtifactError, WebviewResponder, WebviewScheme};

/// Format an artifact directory path for diagnostics, including the resolved
/// path against the current working directory when `path` is relative.
fn format_artifact_path(path: &Path) -> String {
    if path.is_relative()
        && let Ok(cwd) = std::env::current_dir()
    {
        return format!(
            "{} (resolved to {})",
            path.display(),
            cwd.join(path).display()
        );
    }
    path.display().to_string()
}

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
        "could not open the build in {}: {source}; build the frontend before starting the server",
        format_artifact_path(directory)
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
    #[cfg(feature = "dev-reload")]
    #[error(transparent)]
    Reload(#[from] crate::ReloadError),
    #[cfg(feature = "vite-dev")]
    #[error("could not run from the Vite dev server at {url}: {source}")]
    Vite {
        url: String,
        source: crate::ViteDevError,
    },
}

enum ArtifactSource {
    Directory(PathBuf),
    Embedded {
        artifact: Artifact,
        dev_directory: Option<PathBuf>,
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
///   error. A request the client cancels runs to its end
///   ([`CancelledCalls::Finish`]), since a new instance would load every
///   module from Vite again.
/// - Otherwise, with `dev`, [`DevReload`](crate::DevReload) serves each build
///   written to the directory and reloads open pages.
/// - Otherwise the build is opened once.
///
/// Keep `dev` and `vite-dev` out of release builds.
pub struct Server {
    source: ArtifactSource,
    backend: Option<Backend>,
    services: Arc<ServicesFn>,
    routes: Arc<RoutesFn>,
    limits: Limits,
    worker: Option<WorkerOptions>,
    queue_capacity: Option<NonZeroUsize>,
    instances: Option<Instances>,
    public_origin: Option<String>,
    rendering: Arc<RenderingFn>,
    #[cfg(feature = "process")]
    isolation: fetchlet::Isolation,
}

impl Server {
    /// A server for the artifact in `directory`, the output directory of
    /// `fetchlet/build`. A relative path is resolved against the working
    /// directory.
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self::with_source(ArtifactSource::Directory(directory.into()))
    }

    /// A server for an already-opened or embedded [`Artifact`], such as one
    /// created with [`include_artifact!`](crate::include_artifact).
    ///
    /// Combine with [`dev_directory`](Self::dev_directory) to reload from a
    /// build directory when `dev-reload` is enabled while serving the embedded
    /// artifact in release builds without `#[cfg]` branches.
    pub fn from_artifact(artifact: Artifact) -> Self {
        Self::with_source(ArtifactSource::Embedded {
            artifact,
            dev_directory: None,
        })
    }

    /// When built with `dev-reload` and started from an embedded artifact via
    /// [`from_artifact`](Self::from_artifact), watch and reload builds from
    /// `directory` instead of serving the embedded copy. Ignored when
    /// `dev-reload` is disabled.
    pub fn dev_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        if let ArtifactSource::Embedded { dev_directory, .. } = &mut self.source {
            *dev_directory = Some(directory.into());
        }
        self
    }

    fn with_source(source: ArtifactSource) -> Self {
        Self {
            source,
            backend: None,
            services: Arc::new(|| Ok(HostServices::new())),
            routes: Arc::new(|_| Router::new()),
            limits: Self::default_limits(),
            worker: None,
            queue_capacity: None,
            instances: None,
            public_origin: None,
            rendering: Arc::new(|service| service),
            #[cfg(feature = "process")]
            isolation: fetchlet::Isolation::default(),
        }
    }

    /// The engine and its options. By default, the engine the artifact was
    /// built for, through [`Backend::for_target`]; on QuickJS or V8 the
    /// limits then get a 64 MiB `Limits::heap_bytes` unless they set one.
    /// While the worker keeps its default stack, QuickJS also gets a 4 MiB
    /// stack limit and Boa a value stack of 131,072 slots and a recursion
    /// limit of 10,000 calls. A backend given here is used as it is, with
    /// the limits as they are. `V8Options::reliable_termination` stays off
    /// unless a backend given here sets it.
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

    /// The application's caller budgets, used as they are.
    /// [`Server::default_limits`] by default; start from it to keep its
    /// timeouts, or from [`Limits::default`] to run without them.
    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// The limits a server has unless [`limits`](Self::limits) replaces
    /// them: a 10 s `busy_timeout` and a 60 s `startup_timeout`, which retire
    /// an instance whose JavaScript stops returning to the event loop or
    /// whose module never finishes evaluating; no others.
    pub fn default_limits() -> Limits {
        Artifact::default_limits()
    }

    /// The application's worker options. By default, a queue of 8 commands,
    /// one instance and a 64 MiB native stack for each worker thread.
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

    /// The instances that serve requests, keeping the rest of the worker
    /// options. One by default. Each runs one request at a time and has its
    /// own engine heap and module state; see [`Instances`].
    pub fn instances(mut self, instances: Instances) -> Self {
        self.instances = Some(instances);
        self
    }

    /// Where each instance's engine runs. In this process by default. Under
    /// [`Isolation::Process`](fetchlet::Isolation::Process), each instance
    /// runs in a child process, which the server's executable serves when
    /// `main` calls [`fetchlet::serve_if_child`] first. Unless the options
    /// set `ProcessOptions::stack_bytes`, the child's engine thread gets the
    /// worker's native stack, which the default engine stack limits need.
    #[cfg(feature = "process")]
    pub fn isolation(mut self, isolation: fetchlet::Isolation) -> Self {
        self.isolation = isolation;
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

    /// Start the application for a webview's custom URI scheme, such as
    /// Tauri's, instead of a listener. The application sees the scheme's
    /// origin unless [`public_origin`](Self::public_origin) names another.
    /// `response_body_bytes` bounds each response the webview receives
    /// whole ([`WebviewResponder`]).
    ///
    /// With `dev`, each build written to the directory serves the next
    /// request, and [`Webview::reloads`] tells the host when to reload its
    /// window; pages get no reload script. `vite-dev` does not apply.
    pub async fn webview(
        self,
        scheme: WebviewScheme,
        response_body_bytes: usize,
    ) -> Result<Webview, ServerError> {
        let origin = self
            .public_origin
            .clone()
            .unwrap_or_else(|| scheme.origin());
        let (settings, services, source) = self.into_settings(origin);

        let builds = match source {
            ArtifactSource::Directory(directory) => {
                #[cfg(feature = "dev-reload")]
                {
                    WebviewBuilds::Reloading(
                        start_webview_reload(directory, settings, services).await?,
                    )
                }
                #[cfg(not(feature = "dev-reload"))]
                {
                    let artifact = open(&directory)?;
                    let (router, app) = settings.application(&artifact, services()?).await?;
                    WebviewBuilds::Static(Built { router, app })
                }
            }
            ArtifactSource::Embedded {
                artifact,
                dev_directory,
            } => {
                #[cfg(feature = "dev-reload")]
                if let Some(directory) = dev_directory {
                    WebviewBuilds::Reloading(
                        start_webview_reload(directory, settings, services).await?,
                    )
                } else {
                    let (router, app) = settings.application(&artifact, services()?).await?;
                    WebviewBuilds::Static(Built { router, app })
                }
                #[cfg(not(feature = "dev-reload"))]
                {
                    let _ = dev_directory;
                    let (router, app) = settings.application(&artifact, services()?).await?;
                    WebviewBuilds::Static(Built { router, app })
                }
            }
        };
        Ok(Webview {
            inner: Arc::new(WebviewInner {
                builds,
                response_body_bytes,
            }),
        })
    }

    fn into_settings(self, origin: String) -> (Arc<Settings>, Arc<ServicesFn>, ArtifactSource) {
        let settings = Arc::new(Settings {
            backend: self.backend,
            routes: self.routes,
            limits: self.limits,
            worker: self.worker,
            queue_capacity: self.queue_capacity,
            instances: self.instances,
            origin,
            rendering: self.rendering,
            #[cfg(feature = "process")]
            isolation: self.isolation,
        });
        (settings, self.services, self.source)
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
        let (settings, services, source) = self.into_settings(origin);

        #[cfg(feature = "vite-dev")]
        if let Ok(url) = std::env::var(VITE_URL_VARIABLE) {
            return serve_vite(listener, signal, &settings, &services, &url).await;
        }

        match source {
            ArtifactSource::Directory(directory) => {
                #[cfg(feature = "dev-reload")]
                return serve_reloading(listener, signal, settings, services, directory).await;

                #[cfg(not(feature = "dev-reload"))]
                {
                    let artifact = open(&directory)?;
                    serve_static(listener, signal, &settings, &services, &artifact).await
                }
            }
            ArtifactSource::Embedded {
                artifact,
                dev_directory,
            } => {
                #[cfg(feature = "dev-reload")]
                if let Some(directory) = dev_directory {
                    return serve_reloading(listener, signal, settings, services, directory).await;
                }
                let _ = dev_directory;
                serve_static(listener, signal, &settings, &services, &artifact).await
            }
        }
    }
}

/// A [`Server`] started for a webview's custom URI scheme: answers its
/// requests and holds the application. Clones share it.
///
/// ```rust,ignore
/// const SCHEME: WebviewScheme = WebviewScheme::new("app");
/// let webview = Server::new("build").webview(SCHEME, 16 << 20).await?;
/// tauri::Builder::default()
///     .register_asynchronous_uri_scheme_protocol(SCHEME.name(), move |_, request, responder| {
///         let webview = webview.clone();
///         tauri::async_runtime::spawn(async move {
///             responder.respond(webview.respond(request).await);
///         });
///     })
/// ```
#[derive(Clone)]
pub struct Webview {
    inner: Arc<WebviewInner>,
}

enum WebviewBuilds {
    #[cfg(feature = "dev-reload")]
    Reloading(crate::DevReload<Built>),
    Static(Built),
}

struct WebviewInner {
    builds: WebviewBuilds,
    response_body_bytes: usize,
}

/// One build's routes and application.
#[derive(Clone)]
struct Built {
    router: Router,
    app: AppHandle,
}

impl Webview {
    /// The response to a webview request, from the build current when it
    /// arrives: Rust routes, then client assets, then the application.
    pub async fn respond(&self, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        WebviewResponder::new(|| self.router(), self.inner.response_body_bytes)
            .respond(request)
            .await
    }

    /// The routes of the current build, for a host that answers its
    /// requests itself.
    pub fn router(&self) -> Router {
        self.current().router
    }

    /// The application of the current build, whose named exports Rust can
    /// call with [`AppHandle::call`].
    pub fn app(&self) -> AppHandle {
        self.current().app
    }

    /// Each new build from now on, for the host to reload its window.
    /// Ends immediately when started from an embedded artifact without
    /// [`Server::dev_directory`].
    #[cfg(feature = "dev-reload")]
    pub fn reloads(&self) -> crate::Reloads {
        match &self.inner.builds {
            WebviewBuilds::Reloading(reload) => reload.reloads(),
            WebviewBuilds::Static(_) => crate::Reloads::closed(),
        }
    }

    /// Shut the application down; requests after this fail.
    pub async fn shutdown(&self) -> Result<(), ServerError> {
        match &self.inner.builds {
            #[cfg(feature = "dev-reload")]
            WebviewBuilds::Reloading(reload) => reload.shutdown().await?,
            WebviewBuilds::Static(built) => built.app.shutdown().await?,
        }
        Ok(())
    }

    fn current(&self) -> Built {
        match &self.inner.builds {
            #[cfg(feature = "dev-reload")]
            WebviewBuilds::Reloading(reload) => reload.current(),
            WebviewBuilds::Static(built) => built.clone(),
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
    instances: Option<Instances>,
    origin: String,
    rendering: Arc<RenderingFn>,
    #[cfg(feature = "process")]
    isolation: fetchlet::Isolation,
}

impl Settings {
    /// Start the application for `artifact` and route to it.
    async fn application(
        &self,
        artifact: &Artifact,
        services: HostServices,
    ) -> Result<(Router, AppHandle), ServerError> {
        self.start(artifact, services, None).await
    }

    /// [`application`](Self::application), with the worker's
    /// `cancelled_calls` replaced when given.
    async fn start(
        &self,
        artifact: &Artifact,
        services: HostServices,
        cancelled_calls: Option<CancelledCalls>,
    ) -> Result<(Router, AppHandle), ServerError> {
        let mut worker = self
            .worker
            .clone()
            .unwrap_or_else(Artifact::default_worker_options);
        if let Some(capacity) = self.queue_capacity {
            worker.queue_capacity = capacity;
        }
        if let Some(instances) = self.instances {
            worker.instances = instances;
        }
        if let Some(cancelled_calls) = cancelled_calls {
            worker.cancelled_calls = cancelled_calls;
        }
        let mut limits = self.limits.clone();
        let backend = match self.backend {
            Some(backend) => backend,
            None => {
                let backend = default_backend(artifact, &worker)?;
                if backend.bounds_heap() {
                    limits.heap_bytes.get_or_insert(DEFAULT_HEAP_BYTES);
                }
                backend
            }
        };
        let mut builder =
            App::builder(backend)
                .module(
                    Module::new(artifact.server_source().map_err(|source| {
                        ServerError::Artifact {
                            directory: artifact.directory().map(PathBuf::from).unwrap_or_default(),
                            source,
                        }
                    })?)
                    .requires(artifact.requirements()),
                )
                .fetch_handler(artifact.handler())
                .host_services(services)
                .limits(limits);
        #[cfg(feature = "process")]
        {
            let mut isolation = self.isolation.clone();
            if let fetchlet::Isolation::Process(options) = &mut isolation
                && options.stack_bytes.is_none()
            {
                options.stack_bytes = worker.stack_size_bytes.map(NonZeroUsize::get);
            }
            builder = builder.isolation(isolation);
        }
        // Host transport tasks, such as pooled connections, run on the
        // server's runtime, so no instance's JavaScript holds them up. A
        // current-thread runtime progresses only while its own thread waits,
        // so it is left to the workers.
        if let Ok(runtime) = tokio::runtime::Handle::try_current()
            && runtime.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
        {
            builder = builder.host_runtime(runtime);
        }
        let app = builder.spawn(worker).await?;
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
    if worker.stack_size_bytes >= Some(MINIMUM_STACK_FOR_DEFAULT_LIMITS) {
        return Ok(backend
            .with_default_quickjs_stack(DEFAULT_QUICKJS_STACK_BYTES)
            .with_default_boa_stack(DEFAULT_BOA_STACK_SLOTS, DEFAULT_BOA_RECURSION));
    }
    Ok(backend)
}

#[cfg(not(feature = "dev-reload"))]
fn open(directory: &std::path::Path) -> Result<Artifact, ServerError> {
    Artifact::open(directory).map_err(|source| ServerError::Artifact {
        directory: directory.to_path_buf(),
        source,
    })
}

async fn serve_static(
    listener: TcpListener,
    signal: impl Future<Output = ()> + Send + 'static,
    settings: &Settings,
    services: &Arc<ServicesFn>,
    artifact: &Artifact,
) -> Result<(), ServerError> {
    let (router, app) = settings.application(artifact, services()?).await?;
    let result = run(listener, router, signal).await;
    app.shutdown().await?;
    result
}

#[cfg(feature = "dev-reload")]
async fn start_webview_reload(
    directory: PathBuf,
    settings: Arc<Settings>,
    services: Arc<ServicesFn>,
) -> Result<crate::DevReload<Built>, ServerError> {
    use crate::{DevReload, Generation, ReloadError};

    DevReload::watch(directory.clone())
        .start(move |artifact| {
            let (settings, services) = (settings.clone(), services.clone());
            async move {
                let (router, app) = settings.application(&artifact, services()?).await?;
                let built = Built {
                    router,
                    app: app.clone(),
                };
                Ok::<_, ServerError>(Generation::new(built).with_app(app))
            }
        })
        .await
        .map_err(|error| match error {
            ReloadError::Artifact(source) => ServerError::Artifact { directory, source },
            error => ServerError::Reload(error),
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
#[cfg(feature = "dev-reload")]
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
    // A new instance fetches and evaluates every module from Vite again, so
    // a cancelled request finishes in the instance instead of retiring it.
    let (router, app) = settings
        .start(&artifact, services, Some(CancelledCalls::Finish))
        .await?;
    let result = run(
        listener,
        Router::new().fallback_service(vite.proxy(router)),
        signal,
    )
    .await;
    app.shutdown().await?;
    result
}

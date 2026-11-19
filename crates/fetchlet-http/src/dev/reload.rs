use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fetchlet::AppHandle;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::service::DevService;
use crate::{Artifact, ArtifactError, BoxError};

/// How often the manifest is checked by default. A rebuild is noticed within
/// this interval; checking reads one file's metadata, so a short interval
/// costs little.
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// What one build of the artifact serves: a service and the applications it
/// uses, which are shut down when a later build replaces them.
pub struct Generation<S> {
    service: S,
    apps: Vec<AppHandle>,
}

impl<S> Generation<S> {
    pub fn new(service: S) -> Self {
        Self {
            service,
            apps: Vec::new(),
        }
    }

    /// Shut `app` down when this generation is replaced or the reload stops.
    pub fn with_app(mut self, app: AppHandle) -> Self {
        self.apps.push(app);
        self
    }
}

/// A failure while loading a new build. The previous generation keeps
/// serving.
#[derive(Debug, thiserror::Error)]
pub enum ReloadError {
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error("could not start the new build: {0}")]
    Build(BoxError),
    #[error("could not shut down the previous build: {0}")]
    Shutdown(fetchlet::Error),
}

type ErrorCallback = Arc<dyn Fn(&ReloadError) + Send + Sync>;

/// Settings for [`DevReload`].
pub struct DevReloadBuilder {
    directory: PathBuf,
    poll_interval: Duration,
    on_error: ErrorCallback,
}

impl DevReloadBuilder {
    /// How often `fetchlet.json` is checked for a new build. 200 ms by default.
    pub fn poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    /// Report failed reloads. By default they are written to standard error.
    pub fn on_error(mut self, callback: impl Fn(&ReloadError) + Send + Sync + 'static) -> Self {
        self.on_error = Arc::new(callback);
        self
    }

    /// Open the artifact, build the first generation with `build`, and start
    /// watching for new builds. Fails when the first generation fails.
    pub async fn start<S, F, Fut, E>(self, build: F) -> Result<DevReload<S>, ReloadError>
    where
        S: Clone + Send + Sync + 'static,
        F: Fn(Artifact) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Generation<S>, E>> + Send + 'static,
        E: Into<BoxError> + 'static,
    {
        let manifest = self.directory.join("fetchlet.json");
        let stamp = Stamp::read(&manifest);
        let first = build(Artifact::open(&self.directory)?)
            .await
            .map_err(|error| ReloadError::Build(error.into()))?;
        let process = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let (token, _) = watch::channel(format!("{process:x}-0"));
        let shared = Arc::new(Shared {
            current: RwLock::new(Current {
                service: first.service,
                apps: first.apps,
            }),
            token,
        });
        let task = tokio::spawn(watch_builds(Watch {
            directory: self.directory,
            manifest,
            stamp,
            poll_interval: self.poll_interval,
            on_error: self.on_error,
            shared: shared.clone(),
            build,
            process,
        }));
        Ok(DevReload { shared, task })
    }
}

/// Serves an artifact while it is rebuilt, for development.
///
/// A build tool such as `vite build --watch` rewrites the artifact directory
/// and writes `fetchlet.json` last. When the manifest changes, `DevReload`
/// opens the artifact again, builds a new [`Generation`] with the caller's
/// function, serves it from then on and shuts the previous applications down
/// after their accepted calls finish. A failed reload is reported and the
/// previous generation keeps serving.
///
/// [`DevReload::service`] serves the current generation and reloads browsers
/// that show one of its HTML pages when a new one starts.
pub struct DevReload<S> {
    shared: Arc<Shared<S>>,
    task: JoinHandle<()>,
}

impl DevReload<()> {
    /// Watch the artifact in `directory`.
    pub fn watch(directory: impl Into<PathBuf>) -> DevReloadBuilder {
        DevReloadBuilder {
            directory: directory.into(),
            poll_interval: DEFAULT_POLL_INTERVAL,
            on_error: Arc::new(|error| eprintln!("fetchlet reload failed: {error}")),
        }
    }
}

impl<S: Clone> DevReload<S> {
    /// A service that dispatches each request to the current generation.
    pub fn service(&self) -> DevService<S> {
        DevService::new(self.shared.clone())
    }

    /// Stop watching and shut down the current generation's applications.
    pub async fn shutdown(self) -> Result<(), ReloadError> {
        self.task.abort();
        let apps = std::mem::take(&mut self.shared.write().apps);
        for app in apps {
            app.shutdown().await.map_err(ReloadError::Shutdown)?;
        }
        Ok(())
    }
}

impl<S> Drop for DevReload<S> {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) struct Shared<S> {
    current: RwLock<Current<S>>,
    /// Identifies the generation being served, so browsers can tell when it
    /// changes. It includes the process start, so a restarted server reloads
    /// pages too.
    pub(super) token: watch::Sender<String>,
}

struct Current<S> {
    service: S,
    apps: Vec<AppHandle>,
}

impl<S: Clone> Shared<S> {
    /// The current service and its token.
    pub(super) fn current(&self) -> (S, String) {
        let current = self.current.read().unwrap_or_else(PoisonError::into_inner);
        (current.service.clone(), self.token.borrow().clone())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Current<S>> {
        self.current.write().unwrap_or_else(PoisonError::into_inner)
    }
}

struct Watch<S, F> {
    directory: PathBuf,
    manifest: PathBuf,
    stamp: Option<Stamp>,
    poll_interval: Duration,
    on_error: ErrorCallback,
    shared: Arc<Shared<S>>,
    build: F,
    process: u128,
}

async fn watch_builds<S, F, Fut, E>(mut watch: Watch<S, F>)
where
    S: Clone + Send + Sync + 'static,
    F: Fn(Artifact) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Generation<S>, E>> + Send + 'static,
    E: Into<BoxError> + 'static,
{
    let mut generation = 0u64;
    loop {
        tokio::time::sleep(watch.poll_interval).await;
        // A missing manifest is a build in progress; wait for it to return.
        let Some(stamp) = Stamp::read(&watch.manifest) else {
            continue;
        };
        if watch.stamp == Some(stamp) {
            continue;
        }
        watch.stamp = Some(stamp);
        let next = match Artifact::open(&watch.directory) {
            Ok(artifact) => (watch.build)(artifact)
                .await
                .map_err(|error| ReloadError::Build(error.into())),
            Err(error) => Err(error.into()),
        };
        let next = match next {
            Ok(next) => next,
            Err(error) => {
                (watch.on_error)(&error);
                continue;
            }
        };
        generation += 1;
        let previous = {
            let mut current = watch.shared.write();
            current.service = next.service;
            std::mem::replace(&mut current.apps, next.apps)
        };
        watch
            .shared
            .token
            .send_replace(format!("{:x}-{generation}", watch.process));
        let on_error = watch.on_error.clone();
        tokio::spawn(async move {
            for app in previous {
                if let Err(error) = app.shutdown().await {
                    on_error(&ReloadError::Shutdown(error));
                }
            }
        });
    }
}

/// What identifies one write of the manifest. The build replaces the file
/// even when its content is unchanged, so the modification time changes
/// with every build.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    modified: SystemTime,
    len: u64,
}

impl Stamp {
    /// `None` while the manifest cannot be read, such as between a build
    /// removing and replacing it.
    fn read(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            modified: metadata.modified().ok()?,
            len: metadata.len(),
        })
    }
}

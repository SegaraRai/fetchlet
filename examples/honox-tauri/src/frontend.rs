use anyhow::{Context, Result};

use fetchlet::{App, AppHandle, Module};
use fetchlet_http::Artifact;

use crate::config::Config;
use crate::protocol::Protocol;
use crate::services::host_services;

/// One build of the HonoX artifact: the protocol that serves its pages and
/// the application that commands call.
#[derive(Clone)]
pub(crate) struct Build {
    pub protocol: Protocol,
    pub app: AppHandle,
}

impl Build {
    async fn start(config: &Config, artifact: &Artifact) -> Result<Self> {
        let client_directory = artifact
            .client_directory()
            .context("the HonoX artifact has no client directory")?;
        let app = App::builder(config.backend()?)
            .module(Module::new(artifact.server_source()?))
            .fetch_handler(artifact.handler())
            .host_services(host_services(&config.message)?)
            .limits(config.limits())
            .spawn(config.worker_options())
            .await?;
        let protocol = Protocol::new(
            app.clone(),
            &client_directory,
            config.response_body_bytes.get(),
        )?;
        Ok(Self { protocol, app })
    }
}

/// The build the window shows: the one in `build_directory`, or with the
/// `dev` feature each build the `dev` task writes there.
pub(crate) struct Frontend {
    #[cfg(not(feature = "dev"))]
    build: Build,
    #[cfg(feature = "dev")]
    reload: fetchlet_http::DevReload<Build>,
}

const MISSING_BUILD: &str = "build the HonoX frontend before starting the app";

impl Frontend {
    #[cfg(not(feature = "dev"))]
    pub async fn start(config: Config) -> Result<Self> {
        let artifact = Artifact::open(&config.build_directory).context(MISSING_BUILD)?;
        let build = Build::start(&config, &artifact).await?;
        Ok(Self { build })
    }

    /// Start serving the current build and watch for the next ones.
    #[cfg(feature = "dev")]
    pub async fn start(config: Config) -> Result<Self> {
        use std::sync::Arc;

        use fetchlet_http::{DevReload, Generation};

        let directory = config.build_directory.clone();
        let config = Arc::new(config);
        let reload = DevReload::watch(directory)
            .start(move |artifact| {
                let config = config.clone();
                async move {
                    let build = Build::start(&config, &artifact).await?;
                    let app = build.app.clone();
                    anyhow::Ok(Generation::new(build).with_app(app))
                }
            })
            .await
            .context(MISSING_BUILD)?;
        Ok(Self { reload })
    }

    /// The build that serves the next request.
    pub fn current(&self) -> Build {
        #[cfg(not(feature = "dev"))]
        return self.build.clone();
        #[cfg(feature = "dev")]
        return self.reload.current();
    }

    /// Each new build from now on.
    #[cfg(feature = "dev")]
    pub fn reloads(&self) -> fetchlet_http::Reloads {
        self.reload.reloads()
    }

    pub async fn shutdown(&self) -> Result<()> {
        #[cfg(not(feature = "dev"))]
        self.build.app.shutdown().await?;
        #[cfg(feature = "dev")]
        self.reload.shutdown().await?;
        Ok(())
    }
}

use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::Router;
use axum::response::IntoResponse;
use axum::routing::get;
use tokio::net::TcpListener;

use fetchlet::{App, AppHandle, HostServices, Module};
use fetchlet_http::{Artifact, AxumService, artifact_router};

use crate::config::Config;
use crate::services::host_services;

pub(crate) async fn run(config: Config) -> Result<()> {
    let listener = TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let origin = config
        .public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{address}"));
    #[cfg(feature = "vite-dev")]
    if let Ok(url) = std::env::var("FETCHLET_VITE_URL") {
        return run_vite(listener, config, origin, &url).await;
    }
    #[cfg(feature = "dev")]
    return run_reloading(listener, config, origin).await;
    #[cfg(not(feature = "dev"))]
    {
        let artifact = Artifact::open(&config.build_directory)
            .context("build the Astro frontend before starting the server")?;
        let services = host_services(&config.message)?;
        let (router, app) = application(&config, &origin, &artifact, services).await?;
        let result = serve(listener, router).await;
        app.shutdown().await?;
        result
    }
}

/// Serve each build the `dev` task writes, for development.
#[cfg(feature = "dev")]
async fn run_reloading(listener: TcpListener, config: Config, origin: String) -> Result<()> {
    use std::sync::Arc;

    use fetchlet_http::{DevReload, Generation};

    let directory = config.build_directory.clone();
    let config = Arc::new(config);
    let reload = DevReload::watch(directory)
        .start(move |artifact| {
            let (config, origin) = (config.clone(), origin.clone());
            async move {
                let services = host_services(&config.message)?;
                let (router, app) = application(&config, &origin, &artifact, services).await?;
                anyhow::Ok(Generation::new(router).with_app(app))
            }
        })
        .await
        .context("build the Astro frontend before starting the server")?;
    let result = serve(listener, Router::new().fallback_service(reload.service())).await;
    reload.shutdown().await?;
    result
}

/// Run Astro's development app from a Vite dev server, for development:
/// the engine loads each module from Vite as it changes, and Vite serves the
/// browser modules with hot module replacement.
#[cfg(feature = "vite-dev")]
async fn run_vite(listener: TcpListener, config: Config, origin: String, url: &str) -> Result<()> {
    use fetchlet_http::ViteDev;

    let vite = ViteDev::new(url)?;
    let artifact = vite
        .artifact()
        .await
        .with_context(|| format!("start the dev:vite task's Vite dev server at {url}"))?;
    // Development shows what the server logs.
    let services = vite
        .host_services(host_services(&config.message)?)?
        .console(|level, message| eprintln!("[{level:?}] {message}"));
    let (router, app) = application(&config, &origin, &artifact, services).await?;
    let result = serve(listener, Router::new().fallback_service(vite.proxy(router))).await;
    app.shutdown().await?;
    result
}

/// The routes of one build of the artifact and the application they call.
async fn application(
    config: &Config,
    origin: &str,
    artifact: &Artifact,
    services: HostServices,
) -> Result<(Router, AppHandle)> {
    let app = App::builder(config.backend()?)
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .host_services(services)
        .limits(config.limits())
        .spawn(config.worker_options())
        .await?;
    // Endpoints read uploads as they arrive; declared oversize bodies get 413.
    let rendering = AxumService::new(app.clone(), origin)?
        .stream_request_bodies()
        .on_error(|error| eprintln!("request failed: {error:#}"));
    let router = Router::new()
        .route("/api/rust", get(rust_endpoint))
        .merge(artifact_router(artifact, rendering));
    Ok((router, app))
}

async fn serve(listener: TcpListener, router: Router) -> Result<()> {
    println!("FETCHLET_LISTENING http://{}", listener.local_addr()?);
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn rust_endpoint() -> impl IntoResponse {
    axum::Json(serde_json::json!({ "message": "served by axum" }))
}

async fn shutdown() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("shutdown signal failed: {error}");
    }
}

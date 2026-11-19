use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::response::IntoResponse;
use axum::routing::get;
use tokio::net::TcpListener;

use fetchlet::{App, AppHandle, Module};
use fetchlet_http::{Artifact, AxumService, artifact_router, connect_info};

use crate::config::Config;
use crate::services::{Caller, ProjectsApi, api_router, host_services};

pub(crate) async fn run(config: Config) -> Result<()> {
    let listener = TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let origin = config
        .public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{address}"));
    // The projects outlive each build, so a reload keeps them.
    let api = Arc::new(ProjectsApi::default());
    #[cfg(feature = "dev")]
    return run_reloading(listener, config, origin, api).await;
    #[cfg(not(feature = "dev"))]
    {
        let artifact = Artifact::open(&config.build_directory)
            .context("build the SvelteKit frontend before starting the server")?;
        let (router, app) = application(&config, &origin, &artifact, api).await?;
        let result = serve(listener, router).await;
        app.shutdown().await?;
        result
    }
}

/// Serve each build the `dev` task writes, for development.
#[cfg(feature = "dev")]
async fn run_reloading(
    listener: TcpListener,
    config: Config,
    origin: String,
    api: Arc<ProjectsApi>,
) -> Result<()> {
    use fetchlet_http::{DevReload, Generation};

    let directory = config.build_directory.clone();
    let config = Arc::new(config);
    let reload = DevReload::watch(directory)
        .start(move |artifact| {
            let (config, origin, api) = (config.clone(), origin.clone(), api.clone());
            async move {
                let (router, app) = application(&config, &origin, &artifact, api).await?;
                anyhow::Ok(Generation::new(router).with_app(app))
            }
        })
        .await
        .context("build the SvelteKit frontend before starting the server")?;
    let result = serve(listener, Router::new().fallback_service(reload.service())).await;
    reload.shutdown().await?;
    result
}

/// The routes of one build of the artifact and the application they call.
async fn application(
    config: &Config,
    origin: &str,
    artifact: &Artifact,
    api: Arc<ProjectsApi>,
) -> Result<(Router, AppHandle)> {
    let app = App::builder(config.backend()?)
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .host_services(host_services(&config.message, api.clone())?)
        .limits(config.limits())
        .spawn(config.worker_options())
        .await?;
    let rendering = AxumService::new(app.clone(), origin)?
        // Rust decides the caller; in-process API routes receive it.
        .trusted_context(|parts| {
            let address = connect_info(parts).map_or_else(String::new, |ip| ip.to_string());
            fetchlet::Context::new().with(Caller { address })
        })
        .on_error(|error| eprintln!("request failed: {error:#}"));
    let router = Router::new()
        .route("/api/rust", get(rust_endpoint))
        // The same API router that serves in-process fetches, for browsers.
        .nest("/api/v1", api_router(api))
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

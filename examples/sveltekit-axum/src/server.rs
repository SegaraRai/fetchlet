use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::response::IntoResponse;
use axum::routing::get;
use tokio::net::TcpListener;

use fetchlet::{App, Module};
use fetchlet_http::{Artifact, AxumService, artifact_router, connect_info};

use crate::config::Config;
use crate::services::{Caller, ProjectsApi, api_router, host_services};

pub(crate) async fn run(config: Config) -> Result<()> {
    let artifact = Artifact::open(&config.build_directory)
        .context("build the SvelteKit frontend before starting the server")?;
    let listener = TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let origin = config
        .public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{address}"));
    let api = Arc::new(ProjectsApi::default());
    let app = App::builder(config.backend()?)
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .host_services(host_services(&config.message, api.clone())?)
        .limits(config.limits())
        .spawn(config.worker_options())
        .await?;
    let rendering = AxumService::new(app.clone(), &origin)?
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
        .merge(artifact_router(&artifact, rendering));

    println!("FETCHLET_LISTENING http://{address}");
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await;
    app.shutdown().await?;
    result?;
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

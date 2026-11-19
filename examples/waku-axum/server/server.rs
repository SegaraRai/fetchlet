use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::Router;
use axum::response::IntoResponse;
use axum::routing::get;
use tokio::net::TcpListener;

use fetchlet::{App, Module};
use fetchlet_http::{Artifact, AxumService, artifact_router};

use crate::config::Config;
use crate::services::host_services;

pub(crate) async fn run(config: Config) -> Result<()> {
    let artifact = Artifact::open(&config.build_directory)
        .context("build the Waku frontend before starting the server")?;
    let listener = TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let origin = config
        .public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{address}"));
    let app = App::builder(config.backend()?)
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .host_services(host_services(&config.message)?)
        .limits(config.limits())
        .spawn(config.worker_options())
        .await?;
    // Handlers read uploads as they arrive; declared oversize bodies get 413.
    let rendering = AxumService::new(app.clone(), &origin)?
        .stream_request_bodies()
        .on_error(|error| eprintln!("request failed: {error:#}"));
    let router = Router::new()
        .route("/api/rust", get(rust_endpoint))
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

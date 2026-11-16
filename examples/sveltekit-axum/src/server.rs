use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::ConnectInfo;
use axum::response::IntoResponse;
use axum::routing::get;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

use fetchlet::{App, Backend, Module, WorkerOptions};
use fetchlet_axum::FetchletService;

use crate::config::Config;
use crate::services::{Caller, ProjectsApi, api_router, host_services};

pub(crate) async fn run(config: Config) -> Result<()> {
    let source = std::fs::read_to_string(config.build_directory.join("server.js"))
        .context("build the SvelteKit frontend before starting the server")?;
    let listener = TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let origin = config
        .public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{address}"));
    let api = Arc::new(ProjectsApi::default());
    let app = App::builder(Backend::quickjs())
        .module(Module::new(source))
        .host_services(host_services(&config.message, api.clone())?)
        .limits(config.limits())
        .spawn(WorkerOptions::new(config.queue_capacity))
        .await?;
    let rendering = FetchletService::new(app.clone(), &origin)?
        // Rust decides the caller; in-process API routes receive it.
        .trusted_context(|parts| {
            let address = parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map_or_else(String::new, |ConnectInfo(address)| address.ip().to_string());
            fetchlet::Context::new().with(Caller { address })
        })
        .on_error(|error| eprintln!("request failed: {error:#}"));
    let assets = ServeDir::new(config.build_directory.join("client"))
        .call_fallback_on_method_not_allowed(true)
        .fallback(rendering);
    let router = Router::new()
        .route("/api/rust", get(rust_endpoint))
        // The same API router that serves in-process fetches, for browsers.
        .nest("/api/v1", api_router(api))
        .fallback_service(assets);

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

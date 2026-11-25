//! The Rust host of the SvelteKit example: serves the build in
//! `build_directory` with axum, beside the projects API of `services.rs`,
//! which server-side JavaScript also calls in process.

mod services;

use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use axum::routing::get;
use serde::Deserialize;
use tokio::net::TcpListener;

use fetchlet::{Instances, Limits};
use fetchlet_http::{Server, connect_info};

use services::{Caller, ProjectsApi, api_router};

/// `config.json` beside `Cargo.toml`, or the file the first argument names.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    listen: SocketAddr,
    /// The `fetchlet/build` output, relative to the configuration file.
    build_directory: PathBuf,
    /// The origin the application sees behind a proxy. By default, the
    /// listening address.
    public_origin: Option<String>,
    /// The `MESSAGE` binding.
    message: String,
    request_body_bytes: Option<usize>,
    invocation_timeout_ms: Option<u64>,
    background_timeout_ms: Option<u64>,
    background_tasks: Option<usize>,
    /// Requests waiting for the engine thread; 8 by default.
    queue_capacity: Option<NonZeroUsize>,
    /// The most instances serving requests, each with its own engine and
    /// module state; one by default. More start while every instance is busy.
    max_instances: Option<NonZeroUsize>,
    /// Instances kept while idle, up to `max_instances`; 1 by default.
    min_instances: Option<NonZeroUsize>,
    /// How long an instance above `min_instances` stays idle before it stops.
    instance_idle_timeout_ms: Option<u64>,
    /// Instances that open WebSockets may hold, below `max_instances`; none
    /// by default.
    max_held_connections: Option<usize>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let config = load_config()?;
    let listener = TcpListener::bind(config.listen).await?;
    println!("FETCHLET_LISTENING http://{}", listener.local_addr()?);

    // The projects outlive each build, so a reload under `dev` keeps them.
    let api = Arc::new(ProjectsApi::default());
    let message = config.message.clone();
    let mut server = Server::new(&config.build_directory)
        .host_services({
            let api = api.clone();
            move || services::host_services(&message, api.clone())
        })
        .routes(move |_| {
            Router::new()
                .route("/api/rust", get(rust_endpoint))
                // The same API router that serves in-process fetches, for browsers.
                .nest("/api/v1", api_router(api.clone()))
        })
        .limits(Limits {
            timeout: config.invocation_timeout_ms.map(Duration::from_millis),
            request_body_bytes: config.request_body_bytes,
            background_timeout: config.background_timeout_ms.map(Duration::from_millis),
            background_tasks: config.background_tasks,
            ..Server::default_limits()
        })
        // Rust decides the caller; in-process API routes receive it.
        .rendering(|service| {
            service.trusted_context(|parts| {
                let address = connect_info(parts).map_or_else(String::new, |ip| ip.to_string());
                fetchlet::Context::new().with(Caller { address })
            })
        });
    if let Some(capacity) = config.queue_capacity {
        server = server.queue_capacity(capacity);
    }
    if let Some(max) = config.max_instances {
        server = server.instances(Instances {
            min: config.min_instances.unwrap_or(NonZeroUsize::MIN),
            max,
            idle_timeout: config.instance_idle_timeout_ms.map(Duration::from_millis),
            max_held_connections: config.max_held_connections.unwrap_or(0),
        });
    }
    if let Some(origin) = config.public_origin {
        server = server.public_origin(origin);
    }
    server.serve(listener).await?;
    Ok(())
}

async fn rust_endpoint() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "message": "served by axum" }))
}

fn load_config() -> Result<Config> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config.json"));
    let source =
        std::fs::read(&path).with_context(|| format!("read configuration {}", path.display()))?;
    let mut config: Config = serde_json::from_slice(&source)?;
    if config.build_directory.is_relative() {
        config.build_directory = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(&config.build_directory);
    }
    Ok(config)
}

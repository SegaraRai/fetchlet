use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::http::header::HOST;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use tokio::net::TcpListener;

use crate::config::Config;
use crate::host::{Host, Shell};

pub(crate) struct ServeOptions<'a> {
    pub workspace: &'a Path,
    pub listen: Option<SocketAddr>,
    pub open_browser: bool,
}

/// `mdw serve`: the workspace in a browser, served by axum on a local port.
pub(crate) async fn run(config: Config, options: ServeOptions<'_>) -> Result<()> {
    let listener = TcpListener::bind(options.listen.unwrap_or(config.listen)).await?;
    let address = listener.local_addr()?;
    let authority = address.to_string();
    let origin = format!("http://{authority}");
    let host = Host::start(Arc::new(config), options.workspace, Shell::Browser, &origin).await?;
    let router = host
        .router()
        .layer(middleware::from_fn_with_state(authority, require_host));

    println!("MDW_LISTENING {origin}");
    println!(
        "Serving {} at {origin}",
        host.state.workspace.display_root().display()
    );
    if options.open_browser
        && let Err(error) = open::that_detached(&origin)
    {
        eprintln!("could not open a browser: {error}");
    }
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await;
    host.shutdown().await?;
    result?;
    Ok(())
}

/// Answers only requests addressed to the listening authority. A web page
/// that rebinds its own DNS name to 127.0.0.1 shares no origin with the
/// workspace, so it cannot read or change notes through the browser.
async fn require_host(State(authority): State<String>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok());
    if host != Some(authority.as_str()) {
        return (StatusCode::MISDIRECTED_REQUEST, "unknown host").into_response();
    }
    next.run(request).await
}

async fn shutdown() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("shutdown signal failed: {error}");
    }
}

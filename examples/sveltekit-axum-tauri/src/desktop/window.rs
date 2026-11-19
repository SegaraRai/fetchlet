use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use tauri::{Emitter, RunEvent, WebviewUrl, WebviewWindowBuilder};

use crate::config::Config;
use crate::host::{Host, Shell};

use super::protocol::{PUBLIC_ORIGIN, Protocol, SCHEME, start_url};

/// The Tauri event that carries workspace changes to the page.
const CHANGE_EVENT: &str = "workspace-changed";

/// `mdw desktop`: the workspace in a Tauri window, with no HTTP server.
pub(crate) fn run(config: Config, workspace: &Path) -> Result<()> {
    let host = tauri::async_runtime::block_on(Host::start(&config, workspace, Shell::Desktop))?;
    let protocol = Arc::new(Protocol::new(
        host.router(PUBLIC_ORIGIN)?,
        config.response_body_bytes.get(),
    ));
    let title = format!("{} — mdw", host.state.workspace.info().name);
    let url = start_url().parse()?;
    let mut changes = host.state.workspace.subscribe();

    let desktop = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |_context, request, responder| {
            let protocol = Arc::clone(&protocol);
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol.respond(request).await);
            });
        })
        .setup(move |desktop| {
            let mut window =
                WebviewWindowBuilder::new(desktop, "main", WebviewUrl::CustomProtocol(url))
                    .title(title)
                    .inner_size(1180.0, 800.0);
            if let Some(arguments) = devtools_browser_arguments() {
                window = window.additional_browser_args(&arguments);
            }
            window.build()?;
            let handle = desktop.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::sync::broadcast::error::RecvError;
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            if let Err(error) = handle.emit(CHANGE_EVENT, change) {
                                eprintln!("could not send a change to the window: {error}");
                            }
                        }
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())?;

    println!("MDW_DESKTOP_READY {}", start_url());
    let mut host = Some(host);
    desktop.run(move |_desktop, event| {
        if let RunEvent::Exit = event
            && let Some(host) = host.take()
            && let Err(error) = tauri::async_runtime::block_on(host.shutdown())
        {
            eprintln!("shutdown failed: {error:#}");
        }
    });
    Ok(())
}

/// WebView2 browser arguments that open the DevTools protocol on the port in
/// `FETCHLET_DEVTOOLS_PORT`, which the end-to-end tests drive the window
/// through. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` does not reach the browser
/// on every WebView2 runtime, because wry also sets the arguments through the
/// API. Setting them replaces wry's defaults, so they are repeated here.
fn devtools_browser_arguments() -> Option<String> {
    let port = std::env::var("FETCHLET_DEVTOOLS_PORT").ok()?;
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --autoplay-policy=no-user-gesture-required --remote-debugging-port={port}"
    ))
}

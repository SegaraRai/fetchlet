use anyhow::{Context, Result};
use axum::Router;
use axum::routing::get;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

use fetchlet_http::{Server, WebviewScheme};

use crate::commands;
use crate::config::Config;
use crate::services::host_services;

/// The URI scheme the webview loads pages from. The application sees
/// `http://fetchlet.localhost` on every platform.
const SCHEME: WebviewScheme = WebviewScheme::new("fetchlet");

pub(crate) fn run(config: Config) -> Result<()> {
    let message = config.message.clone();
    let mut server = Server::new(&config.build_directory)
        .host_services(move || host_services(&message))
        .routes(|_| Router::new().route("/api/rust", get(rust_endpoint)))
        .limits(config.limits());
    if let Some(capacity) = config.queue_capacity {
        server = server.queue_capacity(capacity);
    }
    // With the `dev` feature, each build the `dev` task writes serves the
    // next request.
    let webview =
        tauri::async_runtime::block_on(server.webview(SCHEME, config.response_body_bytes.get()))
            .context("build the HonoX frontend before starting the app")?;
    let url = SCHEME.start_url().parse()?;

    let protocol = webview.clone();
    #[cfg(feature = "dev")]
    let mut reloads = webview.reloads();
    let desktop = tauri::Builder::default()
        .manage(webview.clone())
        .register_asynchronous_uri_scheme_protocol(
            SCHEME.name(),
            move |_context, request, responder| {
                let protocol = protocol.clone();
                tauri::async_runtime::spawn(async move {
                    responder.respond(protocol.respond(request).await);
                });
            },
        )
        .invoke_handler(tauri::generate_handler![commands::greet])
        .setup(move |desktop| {
            let mut window =
                WebviewWindowBuilder::new(desktop, "main", WebviewUrl::CustomProtocol(url))
                    .title("HonoX + Tauri")
                    .inner_size(960.0, 720.0);
            if let Some(arguments) = devtools_browser_arguments() {
                window = window.additional_browser_args(&arguments);
            }
            #[cfg_attr(not(feature = "dev"), allow(unused_variables))]
            let window = window.build()?;
            // The scheme's responses go to the webview whole, so the window
            // is reloaded from here rather than by a script in the page.
            #[cfg(feature = "dev")]
            tauri::async_runtime::spawn(async move {
                while reloads.next().await.is_some() {
                    if let Err(error) = window.reload() {
                        eprintln!("could not reload the window: {error}");
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())?;

    println!("FETCHLET_TAURI_READY {}", SCHEME.start_url());
    desktop.run(move |_desktop, event| {
        if let RunEvent::Exit = event
            && let Err(error) = tauri::async_runtime::block_on(webview.shutdown())
        {
            eprintln!("shutdown failed: {error:#}");
        }
    });
    Ok(())
}

async fn rust_endpoint() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "message": "served by the Tauri protocol" }))
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

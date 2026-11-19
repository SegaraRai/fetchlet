use std::sync::Arc;

use anyhow::Result;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

use crate::commands::{self, Functions};
use crate::config::Config;
use crate::frontend::Frontend;
use crate::protocol::{SCHEME, start_url};

pub(crate) fn run(config: Config) -> Result<()> {
    let frontend = Arc::new(tauri::async_runtime::block_on(Frontend::start(config))?);
    let url = start_url().parse()?;

    let protocol_frontend = Arc::clone(&frontend);
    #[cfg(feature = "dev")]
    let mut reloads = frontend.reloads();
    let desktop = tauri::Builder::default()
        .manage(Functions(Arc::clone(&frontend)))
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |_context, request, responder| {
            // Each request goes to the build current when it arrives.
            let protocol = protocol_frontend.current().protocol;
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol.respond(request).await);
            });
        })
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

    println!("FETCHLET_TAURI_READY {}", start_url());
    desktop.run(move |_desktop, event| {
        if let RunEvent::Exit = event
            && let Err(error) = tauri::async_runtime::block_on(frontend.shutdown())
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

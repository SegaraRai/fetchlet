use std::sync::Arc;

use anyhow::{Context, Result};
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

use fetchlet::{App, Module};

use crate::commands::{self, Functions};
use crate::config::Config;
use crate::protocol::{Protocol, SCHEME, start_url};
use crate::services::host_services;

pub(crate) fn run(config: Config) -> Result<()> {
    let source = std::fs::read_to_string(config.build_directory.join("server.js"))
        .context("build the HonoX frontend before starting the app")?;
    let app = tauri::async_runtime::block_on(
        App::builder(config.backend()?)
            .module(Module::new(source))
            .host_services(host_services(&config.message)?)
            .limits(config.limits())
            .spawn(config.worker_options()),
    )?;
    let protocol = Arc::new(Protocol::new(
        app.clone(),
        &config.build_directory.join("client"),
        config.response_body_bytes.get(),
    )?);
    let url = start_url().parse()?;

    let desktop = tauri::Builder::default()
        .manage(Functions(app.clone()))
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |_context, request, responder| {
            let protocol = Arc::clone(&protocol);
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol.respond(request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![commands::greet])
        .setup(move |desktop| {
            WebviewWindowBuilder::new(desktop, "main", WebviewUrl::CustomProtocol(url))
                .title("HonoX + Tauri")
                .inner_size(960.0, 720.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())?;

    println!("FETCHLET_TAURI_READY {}", start_url());
    desktop.run(move |_desktop, event| {
        if let RunEvent::Exit = event
            && let Err(error) = tauri::async_runtime::block_on(app.shutdown())
        {
            eprintln!("shutdown failed: {error:#}");
        }
    });
    Ok(())
}

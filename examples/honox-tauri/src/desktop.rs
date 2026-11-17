use std::sync::Arc;

use anyhow::{Context, Result};
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

use fetchlet::{App, Module};
use fetchlet_http::Artifact;

use crate::commands::{self, Functions};
use crate::config::Config;
use crate::protocol::{Protocol, SCHEME, start_url};
use crate::services::host_services;

pub(crate) fn run(config: Config) -> Result<()> {
    let artifact = Artifact::open(&config.build_directory)
        .context("build the HonoX frontend before starting the app")?;
    let client_directory = artifact
        .client_directory()
        .context("the HonoX artifact has no client directory")?;
    let app = tauri::async_runtime::block_on(
        App::builder(config.backend()?)
            .module(Module::new(artifact.server_source()?))
            .fetch_handler(artifact.handler())
            .host_services(host_services(&config.message)?)
            .limits(config.limits())
            .spawn(config.worker_options()),
    )?;
    let protocol = Arc::new(Protocol::new(
        app.clone(),
        &client_directory,
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

//! Calls a function of the JavaScript module in `build/` and prints its
//! result as JSON:
//!
//! ```text
//! example-vanilla-cli [--build DIRECTORY] FUNCTION [ARGUMENT...]
//! example-vanilla-cli [--build DIRECTORY] --list
//! ```
//!
//! Each argument is read as JSON, or as a string when it is not JSON.
//! FETCHLET_BACKEND selects the engine: quickjs (default), boa or v8.

use std::num::NonZeroUsize;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde_json::Value;

use fetchlet::{App, Backend, HostServices, Module, WorkerOptions};
use fetchlet_http::Artifact;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1).peekable();
    let mut build = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("build");
    if arguments.peek().map(String::as_str) == Some("--build") {
        arguments.next();
        build = arguments
            .next()
            .context("--build takes a directory")?
            .into();
    }
    let Some(function) = arguments.next() else {
        bail!("usage: example-vanilla-cli [--build DIRECTORY] FUNCTION [ARGUMENT...] | --list");
    };

    let artifact =
        Artifact::open(&build).context("build the JavaScript module with `vp run build` first")?;
    let functions = artifact.functions().unwrap_or_default();
    if function == "--list" {
        for name in functions {
            println!("{name}");
        }
        return Ok(());
    }
    if !functions.contains(&function) {
        bail!(
            "the module has no function {function}; it exports {}",
            functions.join(", ")
        );
    }

    // The artifact has no Fetch handler, so the App serves calls only. It
    // runs on a worker thread whose stack fits Boa's and V8's recursion,
    // which the main thread's (1 MiB on Windows) does not.
    let mut worker = WorkerOptions::new(NonZeroUsize::MIN);
    worker.stack_size_bytes = NonZeroUsize::new(WORKER_STACK_BYTES);
    let app = App::builder(backend()?)
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .host_services(HostServices::new().env("GREETING", "Hello")?)
        .spawn(worker)
        .await?;
    let arguments: Vec<Value> = arguments
        .map(|argument| serde_json::from_str(&argument).unwrap_or(Value::String(argument)))
        .collect();
    let result = app.call_json(&function, &arguments).await;
    app.shutdown().await?;
    println!("{}", result?);
    Ok(())
}

/// The worker's stack: 8 MiB, above the platform default that framework
/// recursion in debug builds exceeds.
const WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;

fn backend() -> Result<Backend> {
    match std::env::var("FETCHLET_BACKEND").as_deref() {
        Err(_) | Ok("quickjs") => Ok(Backend::quickjs()),
        #[cfg(feature = "boa")]
        Ok("boa") => Ok(Backend::boa()),
        #[cfg(feature = "v8")]
        Ok("v8") => Ok(Backend::v8()),
        Ok(engine) => bail!("build the program with the {engine} feature to use it"),
    }
}

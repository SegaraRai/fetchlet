//! What crosses between the engine and the host per request, in the example
//! builds: the measurement a process boundary at the bridge is priced by
//! (docs/research/process-isolation.md).
//!
//! ```text
//! host-operations [<bench-dir>] [--frameworks bare,astro] [--backends quickjs,boa,v8]
//!                 [--requests 20] [--output <file>]
//! ```
//!
//! `<bench-dir>` (default `.cache/bench`) holds the artifacts `vp run bench`
//! builds. Each framework and backend builds its App as `startup` does, with
//! the HonoX example's host services, and serves the `vp run bench`
//! endpoints `ssr`, `context` and `echo`. After two unmeasured requests per
//! endpoint, `--requests` more are counted with fetchlet's hidden
//! `operation-counts` feature; the report gives each crossing per request:
//! its calls and the bytes it carried each way.
//!
//! `host-operations --ready` writes one byte and exits, so that `ipc` can
//! time the start of a binary that links all three engines.

use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::{Map, Value, json};

use fetchlet::{
    App, AppHandle, Backend, Body, FetchPolicy, FetchService, HostServices, Instances, Limits,
    Module, Request, Response, WorkerOptions, http, transport_fn,
};
use fetchlet_http::Artifact;

const FRAMEWORKS: &[&str] = &[
    "bare",
    "astro",
    "honox",
    "nuxt",
    "qwik-city",
    "react-router",
    "solidstart",
    "sveltekit",
    "tanstack-start",
    "vinext",
    "waku",
];
const BROWSER: &str = "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36";
const ECHO: &str = r#"{"message":"bench","items":[1,2,3]}"#;

fn main() -> Result<()> {
    let mut directory = PathBuf::from(".cache/bench");
    let mut frameworks: Vec<String> = FRAMEWORKS.iter().map(|name| (*name).to_owned()).collect();
    let mut backends = vec!["quickjs".to_owned(), "boa".to_owned(), "v8".to_owned()];
    let mut requests = 20usize;
    let mut output = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--ready" {
            use std::io::Write as _;
            std::io::stdout().write_all(b"r")?;
            return Ok(());
        }
        if !argument.starts_with("--") {
            directory = PathBuf::from(argument);
            continue;
        }
        let value = args
            .next()
            .with_context(|| format!("{argument} needs a value"))?;
        let list = || value.split(',').map(str::to_owned).collect::<Vec<_>>();
        match argument.as_str() {
            "--frameworks" => frameworks = list(),
            "--backends" => backends = list(),
            "--requests" => requests = value.parse()?,
            "--output" => output = Some(PathBuf::from(&value)),
            _ => bail!("unknown flag {argument}"),
        }
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let mut rows = Vec::new();
    for framework in &frameworks {
        for backend in &backends {
            let build = directory.join(framework).join(backend).join("build");
            if !build.join("server.js").exists() {
                eprintln!("skip {framework}/{backend}: no build");
                continue;
            }
            match runtime.block_on(measure(&build, backend, requests)) {
                Ok(endpoints) => {
                    eprintln!("{framework}/{backend}: {}", summary(&endpoints));
                    rows.push(json!({
                        "framework": framework,
                        "backend": backend,
                        "endpoints": endpoints,
                    }));
                }
                Err(error) => eprintln!("{framework}/{backend} failed: {error:#}"),
            }
        }
    }
    let text = serde_json::to_string_pretty(&json!({ "requests": requests, "rows": rows }))?;
    match output {
        Some(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, text)?
        }
        None => println!("{text}"),
    }
    Ok(())
}

/// Host operations and the bytes they carried, per request.
fn summary(endpoints: &Value) -> String {
    let mut parts = Vec::new();
    for (name, endpoint) in endpoints.as_object().into_iter().flatten() {
        parts.push(format!(
            "{name} {} crossings, {} B",
            endpoint["crossings"], endpoint["bytes"]
        ));
    }
    parts.join("; ")
}

/// The HonoX example's bindings: MESSAGE and a RUST service answering JSON.
fn host_services() -> fetchlet::Result<HostServices> {
    let policy = FetchPolicy::deny_all().allow_origin("https://fetchlet.internal")?;
    let service = FetchService::new(
        transport_fn(|_request| async {
            let body = json!({ "message": "Greetings from the Rust service." });
            let mut response = Response::new(Body::from(body.to_string()));
            response.headers_mut().insert(
                "content-type",
                http::HeaderValue::from_static("application/json"),
            );
            Ok(response)
        }),
        policy,
    );
    HostServices::new()
        .env("MESSAGE", "Welcome.")?
        .service("RUST", service)
}

async fn spawn(build: &std::path::Path, name: &str) -> Result<AppHandle> {
    let artifact = Artifact::open(build)?;
    let source = artifact.server_source()?;
    let backend = Backend::for_target(artifact.backend().unwrap_or(name))?
        .with_default_quickjs_stack(4 * 1024 * 1024)
        .with_default_boa_stack(128 * 1024, 10_000);
    let builder = App::builder(backend)
        .module(Module::new(source.to_string()).requires(artifact.requirements()))
        .fetch_handler(artifact.handler())
        .host_services(host_services()?)
        .limits(Limits {
            timeout: Some(Duration::from_secs(30)),
            ..Limits::default()
        });
    let mut worker = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
    worker.stack_size_bytes = NonZeroUsize::new(64 * 1024 * 1024);
    worker.instances = Instances::default();
    Ok(builder.spawn(worker).await?)
}

fn request(endpoint: &str) -> Result<Request> {
    let builder = http::Request::builder().header("host", "127.0.0.1");
    Ok(match endpoint {
        "ssr" => builder
            .uri("http://127.0.0.1/?name=bench")
            .header("accept", "text/html")
            .header("user-agent", BROWSER)
            .body(Body::empty())?,
        "context" => builder
            .uri("http://127.0.0.1/api/context")
            .body(Body::empty())?,
        "echo" => builder
            .method("POST")
            .uri("http://127.0.0.1/api/echo")
            .header("content-type", "application/json")
            .header("origin", "http://127.0.0.1")
            .body(Body::from(ECHO))?,
        _ => bail!("unknown endpoint {endpoint}"),
    })
}

async fn serve(handle: &AppHandle, endpoint: &str) -> Result<()> {
    let response = handle
        .fetch_with_context(request(endpoint)?, &json!({ "clientAddress": "127.0.0.1" }))
        .await?;
    let status = response.status().as_u16();
    response.into_body().collect(16 << 20).await?;
    if !(200..300).contains(&status) {
        bail!("{endpoint} answered {status}");
    }
    Ok(())
}

async fn measure(build: &std::path::Path, name: &str, requests: usize) -> Result<Value> {
    let handle = spawn(build, name).await?;
    let mut endpoints = Map::new();
    for endpoint in ["ssr", "context", "echo"] {
        for _ in 0..2 {
            serve(&handle, endpoint).await?;
        }
        fetchlet::start_operation_counts();
        for _ in 0..requests {
            serve(&handle, endpoint).await?;
        }
        let counts = fetchlet::take_operation_counts();
        let per = |value: u64| (value as f64 / requests as f64 * 100.0).round() / 100.0;
        let mut operations = Map::new();
        let (mut crossings, mut bytes) = (0u64, 0u64);
        for (operation, count) in &counts {
            // Evaluations and wakes are frames of their own across a
            // boundary; the rest are host calls the engine waits on.
            crossings += count.calls;
            bytes += count.input_bytes + count.output_bytes;
            operations.insert(
                operation.clone(),
                json!({
                    "calls": per(count.calls),
                    "input_bytes": per(count.input_bytes),
                    "output_bytes": per(count.output_bytes),
                }),
            );
        }
        endpoints.insert(
            endpoint.to_owned(),
            json!({
                "crossings": per(crossings),
                "bytes": per(bytes),
                "operations": operations,
            }),
        );
    }
    handle.shutdown().await?;
    Ok(Value::Object(endpoints))
}

//! Splits the cost of one fetch invocation into stages, without HTTP.
//!
//! ```text
//! fetchlet-invoke <probe-dir> [--iterations 5000] [--backends quickjs,boa,v8]
//! ```
//!
//! `<probe-dir>/<backend>/build/server.js` is tools/bench/probe/entry.ts
//! built for that backend. Prints one JSON object per backend with
//! microseconds per operation.

use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};

use fetchlet::{
    App, Backend, Body, FetchPolicy, FetchService, HostServices, Module, QuickJsOptions, Request,
    Response, WorkerOptions, http, transport_fn,
};

const ECHO: &str = r#"{"message":"bench","items":[1,2,3]}"#;
const JS_STAGES: &[&str] = &[
    "url",
    "headers",
    "abortController",
    "stream",
    "arrayBuffer",
    "jsonStringify",
    "textEncode",
    "request",
    "response",
    "wireResponse",
    "readJson",
    "serviceFetch",
    "context",
    "echo",
];

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let directory = PathBuf::from(args.next().context("the probe directory is required")?);
    let mut iterations = 5000usize;
    let mut backends = vec!["quickjs".to_owned(), "boa".to_owned(), "v8".to_owned()];
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .with_context(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--iterations" => iterations = value.parse()?,
            "--backends" => backends = value.split(',').map(str::to_owned).collect(),
            _ => bail!("unknown flag {flag}"),
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    for name in backends {
        let source = std::fs::read_to_string(directory.join(&name).join("build/server.js"))?;
        let report = runtime.block_on(measure(&name, &source, iterations))?;
        println!("{}", serde_json::to_string(&report)?);
    }
    Ok(())
}

fn backend(name: &str) -> Result<Backend> {
    Ok(match name {
        "boa" => Backend::boa(),
        // The examples' React stack limit; the probe does not need it.
        "quickjs" => Backend::QuickJs(QuickJsOptions::default()),
        "v8" => Backend::v8(),
        _ => bail!("unknown backend {name}"),
    })
}

/// The HonoX example's bindings: MESSAGE and a RUST service answering JSON.
fn host_services() -> Result<HostServices> {
    let policy = FetchPolicy::deny_all().allow_origin("https://rust.fetchlet.test")?;
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
    Ok(HostServices::new()
        .env("MESSAGE", "m")?
        .service("RUST", service)?)
}

fn app(name: &str, source: &str, handler: &str) -> Result<App> {
    Ok(App::builder(backend(name)?)
        .module(Module::new(source.to_owned()))
        .host_services(host_services()?)
        .fetch_handler(handler)
        .build()?)
}

fn request(path: &str) -> Result<Request> {
    let builder = http::Request::builder()
        .uri(format!("http://127.0.0.1{path}"))
        .header("host", "127.0.0.1")
        .header("accept", "*/*");
    Ok(if path == "/api/echo" {
        builder
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(ECHO.to_owned()))?
    } else {
        builder.body(Body::empty())?
    })
}

/// Microseconds per run of `$body` after a warmup of up to 200 runs.
macro_rules! timed {
    ($iterations:expr, $body:block) => {{
        for _ in 0..$iterations.min(200) $body
        let start = Instant::now();
        for _ in 0..$iterations $body
        start.elapsed().as_secs_f64() * 1e6 / $iterations as f64
    }};
}

async fn fetch_stage(
    name: &str,
    source: &str,
    handler: &str,
    path: &str,
    iterations: usize,
) -> Result<f64> {
    let mut app = app(name, source, handler)?;
    let context = json!({ "clientAddress": "127.0.0.1" });
    Ok(timed!(iterations, {
        let response = app.fetch_with_context(request(path)?, &context).await?;
        if !response.status().is_success() {
            bail!("{handler} {path}: {}", response.status());
        }
        response.into_body().collect(1 << 20).await?;
    }))
}

async fn measure(name: &str, source: &str, iterations: usize) -> Result<Value> {
    let mut js = BTreeMap::new();
    let mut loop_app = app(name, source, "handle")?;
    for stage in JS_STAGES {
        let micros = loop_app
            .call_json("jsLoop", &[json!(stage), json!(iterations)])
            .await?;
        js.insert(*stage, micros);
    }

    let mut rust = BTreeMap::new();
    let mut call_app = app(name, source, "handle")?;
    rust.insert(
        "call_noop",
        timed!(iterations, {
            call_app.call_json("noop", &[]).await?;
        }),
    );
    for (label, handler, path) in [
        ("fetch_raw", "rawHandle", "/api/context"),
        ("fetch_request_only", "requestOnlyHandle", "/api/context"),
        ("fetch_response_only", "responseOnlyHandle", "/api/context"),
        ("fetch_context", "handle", "/api/context"),
        ("fetch_echo", "handle", "/api/echo"),
        ("fetch_ssr", "handle", "/?name=bench"),
    ] {
        rust.insert(
            label,
            fetch_stage(name, source, handler, path, iterations).await?,
        );
    }

    // The same calls through the worker thread that the HTTP servers use.
    let handle = App::builder(backend(name)?)
        .module(Module::new(source.to_owned()))
        .host_services(host_services()?)
        .spawn(WorkerOptions::new(NonZeroUsize::new(8).expect("non-zero")))
        .await?;
    rust.insert(
        "worker_call_noop",
        timed!(iterations, {
            handle.call_json("noop", &[]).await?;
        }),
    );
    let context = json!({ "clientAddress": "127.0.0.1" });
    rust.insert(
        "worker_fetch_context",
        timed!(iterations, {
            let response = handle
                .fetch_with_context(request("/api/context")?, &context)
                .await?;
            response.into_body().collect(1 << 20).await?;
        }),
    );
    // The JavaScript-only loop on the worker thread, against `js_us.context`.
    let micros = handle
        .call_json("jsLoop", &[json!("context"), json!(iterations)])
        .await?;
    rust.insert("worker_js_context", micros.as_f64().unwrap_or(f64::NAN));
    handle.shutdown().await?;

    Ok(json!({ "backend": name, "iterations": iterations, "js_us": js, "host_us": rust }))
}

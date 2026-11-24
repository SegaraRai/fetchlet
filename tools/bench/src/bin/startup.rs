//! Startup cost and memory of the example builds, without HTTP.
//!
//! ```text
//! startup [<bench-dir>] [--frameworks bare,astro] [--backends quickjs,boa,v8]
//!         [--builds 10] [--instances 4] [--requests 50] [--output <file>]
//!         [--quickjs-memory-mib <n>]
//! ```
//!
//! `<bench-dir>` (default `.cache/bench`) holds `<framework>/<backend>/build`,
//! the artifacts `vp run bench` builds. Each framework and backend runs in a
//! child process of its own, so engine initialization and memory start from
//! the same state, and builds its App as fetchlet-http's axum server does:
//! the artifact's module, requirements and handler, the HonoX example's host
//! services, and one instance on a worker thread with a 64 MiB stack.
//! `--quickjs-memory-mib` sets `QuickJsOptions::memory_limit_bytes`, to find
//! the heap an application needs.
//!
//! The child reports, in milliseconds and bytes:
//!
//! - `first_build_ms`: spawning the first instance, engine initialization
//!   included; `first_response_ms`: its first `GET /?name=bench`;
//! - `build_ms`: the median of `--builds` further instances, built from
//!   clones of the first one's builder as a pool's are, so they share its
//!   compiled code;
//! - `warm_ms`: latency of `--requests` sequential requests on one instance;
//! - `rss_*`: the process's resident memory at start, with one instance
//!   after its requests, and the growth per instance kept alive.

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};

use fetchlet::{
    App, AppBuilder, AppHandle, Backend, Body, FetchPolicy, FetchService, HostServices, Instances,
    Limits, Module, Request, Response, WorkerOptions, http, transport_fn,
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
const BROWSER: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                       (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

struct Options {
    directory: PathBuf,
    frameworks: Vec<String>,
    backends: Vec<String>,
    builds: usize,
    instances: usize,
    requests: usize,
    output: Option<PathBuf>,
    quickjs_memory_mib: usize,
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).peekable();
    if args.peek().map(String::as_str) == Some("--one") {
        args.next();
        let directory = PathBuf::from(args.next().context("directory")?);
        let framework = args.next().context("framework")?;
        let backend = args.next().context("backend")?;
        let builds = args.next().context("builds")?.parse()?;
        let instances = args.next().context("instances")?.parse()?;
        let requests = args.next().context("requests")?.parse()?;
        let memory: usize = args.next().context("memory")?.parse()?;
        let settings = Settings {
            quickjs_memory_bytes: (memory > 0).then_some(memory << 20),
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let report = runtime.block_on(measure(
            &directory.join(&framework).join(&backend).join("build"),
            &backend,
            &settings,
            builds,
            instances,
            requests,
        ))?;
        println!(
            "{}",
            json!({ "framework": framework, "backend": backend, "report": report })
        );
        return Ok(());
    }

    let mut options = Options {
        directory: PathBuf::from(".cache/bench"),
        frameworks: FRAMEWORKS.iter().map(|name| (*name).to_owned()).collect(),
        backends: vec!["quickjs".into(), "boa".into(), "v8".into()],
        builds: 10,
        instances: 4,
        requests: 50,
        output: None,
        quickjs_memory_mib: 0,
    };
    while let Some(argument) = args.next() {
        if !argument.starts_with("--") {
            options.directory = PathBuf::from(argument);
            continue;
        }
        let value = args
            .next()
            .with_context(|| format!("{argument} needs a value"))?;
        let list = || value.split(',').map(str::to_owned).collect::<Vec<_>>();
        match argument.as_str() {
            "--frameworks" => options.frameworks = list(),
            "--backends" => options.backends = list(),
            "--builds" => options.builds = value.parse()?,
            "--instances" => options.instances = value.parse()?,
            "--requests" => options.requests = value.parse()?,
            "--output" => options.output = Some(PathBuf::from(&value)),
            "--quickjs-memory-mib" => options.quickjs_memory_mib = value.parse()?,
            _ => bail!("unknown flag {argument}"),
        }
    }
    if options.instances < 2 {
        bail!("--instances must be at least 2 to measure growth");
    }

    let executable = std::env::current_exe()?;
    let mut rows = Vec::new();
    for framework in &options.frameworks {
        for backend in &options.backends {
            let build = options
                .directory
                .join(framework)
                .join(backend)
                .join("build");
            if !build.join("server.js").exists() {
                eprintln!("skip {framework}/{backend}: no build");
                continue;
            }
            let output = Command::new(&executable)
                .arg("--one")
                .arg(&options.directory)
                .args([framework, backend])
                .arg(options.builds.to_string())
                .arg(options.instances.to_string())
                .arg(options.requests.to_string())
                .arg(options.quickjs_memory_mib.to_string())
                .output()?;
            if !output.status.success() {
                eprintln!(
                    "{framework}/{backend} failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                continue;
            }
            let line = String::from_utf8(output.stdout)?;
            let mut row: Value = serde_json::from_str(line.trim())?;
            row["sizes"] = sizes(&build)?;
            eprintln!("{framework}/{backend}: {}", row["report"]);
            rows.push(row);
        }
    }
    let result = json!({
        "builds": options.builds,
        "instances": options.instances,
        "requests": options.requests,
        "quickjs_memory_mib": options.quickjs_memory_mib,
        "rows": rows,
    });
    let text = serde_json::to_string_pretty(&result)?;
    match &options.output {
        Some(path) => std::fs::write(path, text)?,
        None => println!("{text}"),
    }
    Ok(())
}

/// The bytes of the artifact's parts.
fn sizes(build: &Path) -> Result<Value> {
    let file = |name: &str| std::fs::metadata(build.join(name)).map_or(0, |meta| meta.len());
    Ok(json!({
        "server_js": file("server.js"),
        "assets_flpk": file("assets.flpk"),
        "client": directory_bytes(&build.join("client"))?,
    }))
}

fn directory_bytes(path: &Path) -> Result<u64> {
    if !path.is_dir() {
        return Ok(0);
    }
    let mut total = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        total += if entry.file_type()?.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            entry.metadata()?.len()
        };
    }
    Ok(total)
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

/// Engine settings beyond fetchlet-http's defaults.
struct Settings {
    quickjs_memory_bytes: Option<usize>,
}

/// The artifact's engine with fetchlet-http's default stack limits.
fn backend(artifact: &Artifact, name: &str, settings: &Settings) -> Result<Backend> {
    let target = artifact.backend().unwrap_or(name);
    let backend = Backend::for_target(target)?
        .with_default_quickjs_stack(4 * 1024 * 1024)
        .with_default_boa_stack(128 * 1024, 10_000);
    Ok(match backend {
        Backend::QuickJs(mut options) if settings.quickjs_memory_bytes.is_some() => {
            options.memory_limit_bytes = settings.quickjs_memory_bytes;
            Backend::QuickJs(options)
        }
        other => other,
    })
}

/// One instance on a worker thread with a 64 MiB stack.
async fn spawn(builder: &AppBuilder) -> Result<AppHandle> {
    let mut worker = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
    worker.stack_size_bytes = NonZeroUsize::new(64 * 1024 * 1024);
    worker.instances = Instances::default();
    Ok(builder.clone().spawn(worker).await?)
}

/// The application as the axum server builds it.
fn builder(
    artifact: &Artifact,
    name: &str,
    settings: &Settings,
    source: &str,
) -> Result<AppBuilder> {
    Ok(App::builder(backend(artifact, name, settings)?)
        .module(Module::new(source.to_owned()).requires(artifact.requirements()))
        .fetch_handler(artifact.handler())
        .host_services(host_services()?)
        .limits(Limits {
            timeout: Some(Duration::from_secs(30)),
            ..Limits::default()
        }))
}

/// One server-rendered page; its status and body length.
async fn render(handle: &AppHandle) -> Result<(u16, usize)> {
    let request: Request = http::Request::builder()
        .uri("http://127.0.0.1/?name=bench")
        .header("host", "127.0.0.1")
        .header("accept", "text/html")
        .header("user-agent", BROWSER)
        .body(Body::empty())?;
    let response = handle
        .fetch_with_context(request, &json!({ "clientAddress": "127.0.0.1" }))
        .await?;
    let status = response.status().as_u16();
    let body = response.into_body().collect(16 << 20).await?;
    Ok((status, body.len()))
}

fn ms(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 1e5).round() / 100.0
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index]
}

async fn measure(
    build: &Path,
    name: &str,
    settings: &Settings,
    builds: usize,
    instances: usize,
    requests: usize,
) -> Result<Value> {
    let rss_start = memory::resident();
    let artifact = Artifact::open(build)?;
    let source = artifact.server_source()?;

    let builder = builder(&artifact, name, settings, &source)?;
    let started = Instant::now();
    let first = spawn(&builder).await?;
    let first_build = started.elapsed();
    let started = Instant::now();
    let (status, html_bytes) = render(&first).await?;
    let first_response = started.elapsed();
    if !(200..300).contains(&status) {
        bail!("GET / answered {status}");
    }
    let mut warm = Vec::with_capacity(requests);
    for _ in 0..requests {
        let started = Instant::now();
        render(&first).await?;
        warm.push(ms(started.elapsed()));
    }
    warm.sort_by(f64::total_cmp);
    let rss_one = memory::resident();

    // Further instances: the first `instances - 1` stay alive, each after
    // one request, to measure the memory an instance adds.
    let mut kept = Vec::new();
    let mut build_times = Vec::with_capacity(builds);
    let mut rss_kept = None;
    for index in 0..builds.max(instances - 1) {
        let started = Instant::now();
        let handle = spawn(&builder).await?;
        let elapsed = started.elapsed();
        if index < builds {
            build_times.push(ms(elapsed));
        }
        render(&handle).await?;
        if kept.len() < instances - 1 {
            kept.push(handle);
            if kept.len() == instances - 1 {
                rss_kept = memory::resident();
            }
        } else {
            handle.shutdown().await?;
        }
    }
    build_times.sort_by(f64::total_cmp);
    for handle in kept {
        handle.shutdown().await?;
    }
    first.shutdown().await?;

    let per_instance = match (rss_one, rss_kept) {
        (Some(one), Some(kept)) => Some((kept.saturating_sub(one)) / (instances as u64 - 1)),
        _ => None,
    };
    Ok(json!({
        "status": status,
        "html_bytes": html_bytes,
        "first_build_ms": ms(first_build),
        "first_response_ms": ms(first_response),
        "build_ms": {
            "median": percentile(&build_times, 0.5),
            "min": build_times.first(),
            "max": build_times.last(),
        },
        "warm_ms": {
            "p50": percentile(&warm, 0.5),
            "p90": percentile(&warm, 0.9),
            "p99": percentile(&warm, 0.99),
            "max": warm.last(),
        },
        "rss_start": rss_start,
        "rss_one_instance": rss_one,
        "rss_per_instance": per_instance,
        "rss_peak": memory::peak(),
    }))
}

/// The process's resident memory.
mod memory {
    #[cfg(windows)]
    mod imp {
        #[repr(C)]
        #[derive(Default)]
        struct Counters {
            size: u32,
            page_fault_count: u32,
            peak_working_set: usize,
            working_set: usize,
            quota_peak_paged_pool: usize,
            quota_paged_pool: usize,
            quota_peak_non_paged_pool: usize,
            quota_non_paged_pool: usize,
            pagefile_usage: usize,
            peak_pagefile_usage: usize,
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, size: u32) -> i32;
        }

        fn counters() -> Option<Counters> {
            let mut counters = Counters {
                size: size_of::<Counters>() as u32,
                ..Counters::default()
            };
            // SAFETY: the pseudo handle needs no closing and the struct is
            // the size the call is told.
            let ok = unsafe {
                K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.size)
            };
            (ok != 0).then_some(counters)
        }

        pub fn resident() -> Option<u64> {
            counters().map(|counters| counters.working_set as u64)
        }

        pub fn peak() -> Option<u64> {
            counters().map(|counters| counters.peak_working_set as u64)
        }
    }

    #[cfg(target_os = "linux")]
    mod imp {
        fn status(field: &str) -> Option<u64> {
            let text = std::fs::read_to_string("/proc/self/status").ok()?;
            let line = text.lines().find(|line| line.starts_with(field))?;
            let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
            Some(kib * 1024)
        }

        pub fn resident() -> Option<u64> {
            status("VmRSS:")
        }

        pub fn peak() -> Option<u64> {
            status("VmHWM:")
        }
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    mod imp {
        pub fn resident() -> Option<u64> {
            None
        }

        pub fn peak() -> Option<u64> {
            None
        }
    }

    pub use imp::{peak, resident};
}

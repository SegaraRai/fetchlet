//! Times `AsyncLocalStorage` on each engine with the serialized and the
//! propagated `node:async_hooks`, inside the engine and without HTTP.
//!
//! ```text
//! fetchlet-async-context <dir> [--iterations 200000] [--backends quickjs,boa,v8]
//! ```
//!
//! `<dir>/<backend>-<mode>/build/server.js` is
//! tools/bench/async-context/entry.ts built for that backend with
//! `asyncContext: <mode>`. QuickJS has no async context slot, so it runs the
//! serialized build only. Prints one JSON object per backend and mode with
//! nanoseconds per operation, the median of five rounds.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};

use fetchlet::{App, Backend, Module};

const STAGES: &[&str] = &["run", "getStore", "await", "awaitOutside", "runAwait"];
const ROUNDS: usize = 5;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let directory = PathBuf::from(args.next().context("the build directory is required")?);
    let mut iterations = 200_000usize;
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
        let modes: &[&str] = if name == "quickjs" {
            &["serialized"]
        } else {
            &["serialized", "propagated"]
        };
        for mode in modes {
            let path = directory.join(format!("{name}-{mode}/build/server.js"));
            let source = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            let report = runtime.block_on(measure(&name, mode, &source, iterations))?;
            println!("{}", serde_json::to_string(&report)?);
        }
    }
    Ok(())
}

fn backend(name: &str) -> Result<Backend> {
    Ok(match name {
        "quickjs" => Backend::quickjs(),
        "boa" => Backend::boa(),
        "v8" => Backend::v8(),
        _ => bail!("unknown backend {name}"),
    })
}

async fn measure(name: &str, mode: &str, source: &str, iterations: usize) -> Result<Value> {
    let mut app = App::builder(backend(name)?)
        .module(Module::new(source.to_owned()))
        .build()?;
    let mut stages = BTreeMap::new();
    for stage in STAGES {
        let mut rounds = Vec::with_capacity(ROUNDS);
        for _ in 0..ROUNDS {
            let nanos = app
                .call_json("measure", &[json!(stage), json!(iterations)])
                .await?
                .as_f64()
                .context("measure returns a number")?;
            rounds.push(nanos);
        }
        rounds.sort_by(f64::total_cmp);
        stages.insert(*stage, (rounds[ROUNDS / 2] * 10.0).round() / 10.0);
    }
    Ok(json!({ "backend": name, "asyncContext": mode, "ns": stages }))
}

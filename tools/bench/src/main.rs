//! Drives one endpoint with a fixed number of keep-alive connections. Each
//! connection sends its next request after the previous response body ends,
//! so the reported rate is the server's throughput at that concurrency.
//!
//! ```text
//! fetchlet-bench --url http://127.0.0.1:3000/api/context [--method POST]
//!   [--body '{"a":1}'] [--header 'content-type: application/json']
//!   [--connections 16] [--warmup-ms 2000] [--duration-ms 10000]
//! ```
//!
//! Prints one JSON object with the counts, the rate and latency percentiles.

mod load;
mod options;
mod report;

use anyhow::Result;

fn main() -> Result<()> {
    let options = options::Options::parse(std::env::args().skip(1))?;
    // The client gets its own small pool so it competes little with the
    // server for CPU; the server under test runs one JS worker.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(options.client_threads)
        .enable_all()
        .build()?;
    let samples = runtime.block_on(load::run(&options))?;
    let report = report::Report::new(&options, samples);
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

use serde::Serialize;

use crate::load::Samples;
use crate::options::Options;

#[derive(Serialize)]
pub(crate) struct Report {
    pub connections: usize,
    pub duration_ms: u128,
    pub ok: u64,
    pub bad_status: u64,
    pub transport_errors: u64,
    pub requests_per_second: f64,
    pub response_bytes_per_request: f64,
    pub latency_ms: Latency,
}

#[derive(Serialize)]
pub(crate) struct Latency {
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
    pub max: f64,
}

impl Report {
    pub fn new(options: &Options, mut samples: Samples) -> Self {
        samples.latencies_us.sort_unstable();
        let ok = samples.latencies_us.len() as u64;
        let total = ok + samples.bad_status;
        let seconds = options.duration.as_secs_f64();
        let percentile = |fraction: f64| -> f64 {
            if samples.latencies_us.is_empty() {
                return 0.0;
            }
            let index = ((samples.latencies_us.len() - 1) as f64 * fraction).round() as usize;
            f64::from(samples.latencies_us[index]) / 1000.0
        };
        Self {
            connections: options.connections,
            duration_ms: options.duration.as_millis(),
            ok,
            bad_status: samples.bad_status,
            transport_errors: samples.transport_errors,
            requests_per_second: ok as f64 / seconds,
            response_bytes_per_request: if total == 0 {
                0.0
            } else {
                samples.response_bytes as f64 / total as f64
            },
            latency_ms: Latency {
                p50: percentile(0.50),
                p90: percentile(0.90),
                p99: percentile(0.99),
                max: percentile(1.0),
            },
        }
    }
}

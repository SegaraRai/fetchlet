use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper::body::Bytes;
use hyper::client::conn::http1::{self, SendRequest};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;

use crate::options::Options;

/// What one connection observed during the measured window.
#[derive(Default)]
pub(crate) struct Samples {
    /// Latencies of successful responses, in microseconds.
    pub latencies_us: Vec<u32>,
    /// Responses with a non-2xx status.
    pub bad_status: u64,
    /// Requests that failed at the transport, including reconnects.
    pub transport_errors: u64,
    pub response_bytes: u64,
}

impl Samples {
    fn merge(&mut self, other: Samples) {
        self.latencies_us.extend(other.latencies_us);
        self.bad_status += other.bad_status;
        self.transport_errors += other.transport_errors;
        self.response_bytes += other.response_bytes;
    }
}

pub(crate) async fn run(options: &Options) -> Result<Samples> {
    let start = Instant::now();
    let measure_from = start + options.warmup;
    let stop_at = measure_from + options.duration;
    let shared = Arc::new(Template::new(options)?);
    let tasks: Vec<_> = (0..options.connections)
        .map(|_| {
            let shared = shared.clone();
            tokio::spawn(async move { connection(&shared, measure_from, stop_at).await })
        })
        .collect();
    let mut samples = Samples::default();
    for task in tasks {
        samples.merge(task.await?);
    }
    Ok(samples)
}

struct Template {
    address: String,
    request: Request<Full<Bytes>>,
}

impl Template {
    fn new(options: &Options) -> Result<Self> {
        let mut builder = Request::builder()
            .method(options.method.clone())
            .uri(options.path.clone())
            .header(hyper::header::HOST, options.authority.as_str());
        for (name, value) in &options.headers {
            builder = builder.header(name, value);
        }
        let port = options.authority.port_u16().unwrap_or(80);
        Ok(Self {
            address: format!("{}:{port}", options.authority.host()),
            request: builder
                .body(Full::new(Bytes::from(options.body.clone())))
                .context("build the request template")?,
        })
    }

    fn request(&self) -> Request<Full<Bytes>> {
        let mut request = Request::new(self.request.body().clone());
        *request.method_mut() = self.request.method().clone();
        *request.uri_mut() = self.request.uri().clone();
        *request.headers_mut() = self.request.headers().clone();
        request
    }
}

async fn connect(address: &str) -> Result<SendRequest<Full<Bytes>>> {
    let stream = TcpStream::connect(address).await?;
    stream.set_nodelay(true)?;
    let (sender, connection) = http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(connection);
    Ok(sender)
}

async fn connection(template: &Template, measure_from: Instant, stop_at: Instant) -> Samples {
    let mut samples = Samples::default();
    let mut sender = None;
    loop {
        let sent = Instant::now();
        if sent >= stop_at {
            return samples;
        }
        let measured = sent >= measure_from;
        let outcome = exchange(template, &mut sender).await;
        let elapsed = sent.elapsed();
        if !measured || Instant::now() > stop_at {
            // Responses that straddle the window edges are not counted.
            if outcome.is_err() {
                sender = None;
            }
            continue;
        }
        match outcome {
            Ok((status, bytes)) => {
                samples.response_bytes += bytes;
                if status.is_success() {
                    let micros = u32::try_from(elapsed.as_micros()).unwrap_or(u32::MAX);
                    samples.latencies_us.push(micros);
                } else {
                    samples.bad_status += 1;
                }
            }
            Err(_) => {
                samples.transport_errors += 1;
                sender = None;
            }
        }
    }
}

async fn exchange(
    template: &Template,
    sender: &mut Option<SendRequest<Full<Bytes>>>,
) -> Result<(hyper::StatusCode, u64)> {
    let current = match sender {
        Some(current) if !current.is_closed() => current,
        _ => sender.insert(connect(&template.address).await?),
    };
    current.ready().await?;
    let response = current.send_request(template.request()).await?;
    let status = response.status();
    let body = response.into_body().collect().await?.to_bytes();
    Ok((status, body.len() as u64))
}

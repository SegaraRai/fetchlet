use std::time::Duration;

use anyhow::{Context, Result, bail};
use hyper::Method;
use hyper::http::uri::{Authority, PathAndQuery};

/// Every budget here is the caller's: the orchestrator picks the
/// concurrency and the measurement windows for each run.
pub(crate) struct Options {
    pub authority: Authority,
    pub path: PathAndQuery,
    pub method: Method,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
    pub connections: usize,
    pub client_threads: usize,
    pub warmup: Duration,
    pub duration: Duration,
}

impl Options {
    pub fn parse(mut args: impl Iterator<Item = String>) -> Result<Self> {
        let mut url = None;
        let mut method = Method::GET;
        let mut body = Vec::new();
        let mut headers = Vec::new();
        let mut connections = 16;
        let mut client_threads = 2;
        let mut warmup_ms = 2000;
        let mut duration_ms = 10000;
        while let Some(flag) = args.next() {
            let value = args
                .next()
                .with_context(|| format!("{flag} needs a value"))?;
            match flag.as_str() {
                "--url" => url = Some(value),
                "--method" => method = value.parse()?,
                "--body" => body = value.into_bytes(),
                "--header" => {
                    let (name, value) = value
                        .split_once(':')
                        .with_context(|| format!("header {value:?} has no colon"))?;
                    headers.push((name.trim().to_owned(), value.trim().to_owned()));
                }
                "--connections" => connections = value.parse()?,
                "--client-threads" => client_threads = value.parse()?,
                "--warmup-ms" => warmup_ms = value.parse()?,
                "--duration-ms" => duration_ms = value.parse()?,
                _ => bail!("unknown flag {flag}"),
            }
        }
        let url: hyper::Uri = url.context("--url is required")?.parse()?;
        if url.scheme_str() != Some("http") {
            bail!("only http:// URLs are supported");
        }
        if connections == 0 || client_threads == 0 || duration_ms == 0 {
            bail!("connections, client threads and duration must be positive");
        }
        Ok(Self {
            authority: url.authority().context("the URL needs a host")?.clone(),
            path: url
                .path_and_query()
                .cloned()
                .unwrap_or_else(|| PathAndQuery::from_static("/")),
            method,
            body,
            headers,
            connections,
            client_threads,
            warmup: Duration::from_millis(warmup_ms),
            duration: Duration::from_millis(duration_ms),
        })
    }
}

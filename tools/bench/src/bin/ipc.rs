//! The costs of a process boundary at the bridge
//! (docs/research/process-isolation.md): starting a child process, and
//! round trips of length-prefixed frames over the child's standard input
//! and output.
//!
//! ```text
//! ipc [--starts 30] [--round-trips 20000] [--engine-binary <path>] [--output <file>]
//! ```
//!
//! - `start_ms`: from spawning a child to reading its first byte, the least
//!   a child engine's build adds to an instance's build: of this small
//!   binary, and of `--engine-binary` (default: `host-operations` next to
//!   this one), which links all three engines as an embedder's would;
//! - `round_trip_us`: one request frame and its reply, for message sizes like
//!   the host operations' (64 B to 64 KiB), with the parent's side blocking
//!   on threads (`sync`) and on tokio's process pipes (`tokio`), as a pool's
//!   worker would. The child answers on one thread with blocking reads, as
//!   an engine thread waiting on a host call would.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Request and reply sizes, in bytes.
const SIZES: &[(usize, usize)] = &[(64, 64), (256, 1024), (64, 16 * 1024), (64 * 1024, 64)];

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut starts = 30usize;
    let mut round_trips = 20_000usize;
    let mut output = None;
    let mut engine_binary = std::env::current_exe()?
        .with_file_name(format!("host-operations{}", std::env::consts::EXE_SUFFIX));
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--child" => return child(),
            "--ready" => {
                std::io::stdout().write_all(b"r")?;
                return Ok(());
            }
            _ => {}
        }
        let value = args
            .next()
            .with_context(|| format!("{argument} needs a value"))?;
        match argument.as_str() {
            "--starts" => starts = value.parse()?,
            "--round-trips" => round_trips = value.parse()?,
            "--output" => output = Some(value),
            "--engine-binary" => engine_binary = value.into(),
            _ => bail!("unknown flag {argument}"),
        }
    }

    let start = start_ms(&std::env::current_exe()?, starts)?;
    let engine_start = start_ms(&engine_binary, starts)?;
    eprintln!("start: {start}, with engines: {engine_start}");
    let mut rows = Vec::new();
    for &(request, reply) in SIZES {
        // Large frames take longer; fewer of them give the same precision.
        let count = (round_trips * 64 / request.max(reply)).clamp(500, round_trips);
        let sync = round_trip_sync(request, reply, count)?;
        let tokio = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(round_trip_tokio(request, reply, count))?;
        eprintln!("{request} B -> {reply} B: sync {sync}, tokio {tokio}");
        rows.push(json!({
            "request_bytes": request,
            "reply_bytes": reply,
            "round_trips": count,
            "sync": sync,
            "tokio": tokio,
        }));
    }
    let text = serde_json::to_string_pretty(&json!({
        "os": std::env::consts::OS,
        "binary_bytes": std::fs::metadata(std::env::current_exe()?)?.len(),
        "start_ms": start,
        "engine_binary_bytes": std::fs::metadata(&engine_binary)?.len(),
        "engine_binary_start_ms": engine_start,
        "round_trip_us": rows,
    }))?;
    match output {
        Some(path) => {
            let path = std::path::PathBuf::from(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, text)?
        }
        None => println!("{text}"),
    }
    Ok(())
}

/// Answer frames until standard input closes: each request is a 4-byte
/// little-endian length, a 4-byte reply length and the payload; the reply is
/// a 4-byte length and that many bytes.
fn child() -> Result<()> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut header = [0u8; 8];
    let mut payload = Vec::new();
    let mut reply = Vec::new();
    loop {
        if input.read_exact(&mut header).is_err() {
            return Ok(());
        }
        let length = u32::from_le_bytes(header[..4].try_into()?) as usize;
        let reply_length = u32::from_le_bytes(header[4..].try_into()?) as usize;
        payload.resize(length, 0);
        input.read_exact(&mut payload)?;
        reply.clear();
        reply.extend_from_slice(&(reply_length as u32).to_le_bytes());
        reply.resize(4 + reply_length, b'x');
        output.write_all(&reply)?;
        output.flush()?;
    }
}

fn frame(request: usize, reply: usize) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + request);
    frame.extend_from_slice(&(request as u32).to_le_bytes());
    frame.extend_from_slice(&(reply as u32).to_le_bytes());
    frame.resize(8 + request, b'q');
    frame
}

fn child_command() -> Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--child")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    Ok(command)
}

fn start_ms(program: &std::path::Path, starts: usize) -> Result<Value> {
    let mut times = Vec::with_capacity(starts);
    for _ in 0..starts {
        let started = Instant::now();
        let mut child = Command::new(program)
            .arg("--ready")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()?;
        let mut byte = [0u8; 1];
        child.stdout.take().unwrap().read_exact(&mut byte)?;
        times.push(started.elapsed());
        child.wait()?;
    }
    Ok(distribution(times, 1e3))
}

fn round_trip_sync(request: usize, reply: usize, count: usize) -> Result<Value> {
    let mut child = child_command()?.spawn()?;
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let frame = frame(request, reply);
    let mut buffer = vec![0u8; 4 + reply];
    let mut times = Vec::with_capacity(count);
    for index in 0..count + count / 10 {
        let started = Instant::now();
        input.write_all(&frame)?;
        output.read_exact(&mut buffer)?;
        // The first tenth warms up and is not counted.
        if index >= count / 10 {
            times.push(started.elapsed());
        }
    }
    drop(input);
    child.wait()?;
    Ok(distribution(times, 1e6))
}

async fn round_trip_tokio(request: usize, reply: usize, count: usize) -> Result<Value> {
    let mut child = tokio::process::Command::from(child_command()?).spawn()?;
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let frame = frame(request, reply);
    let mut buffer = vec![0u8; 4 + reply];
    let mut times = Vec::with_capacity(count);
    for index in 0..count + count / 10 {
        let started = Instant::now();
        input.write_all(&frame).await?;
        output.read_exact(&mut buffer).await?;
        if index >= count / 10 {
            times.push(started.elapsed());
        }
    }
    drop(input);
    child.wait().await?;
    Ok(distribution(times, 1e6))
}

/// Percentiles of `times`, in the unit `scale` converts seconds to.
fn distribution(mut times: Vec<Duration>, scale: f64) -> Value {
    times.sort();
    let at = |fraction: f64| {
        let index = ((times.len() as f64 - 1.0) * fraction).round() as usize;
        (times[index].as_secs_f64() * scale * 100.0).round() / 100.0
    };
    json!({ "p50": at(0.5), "p90": at(0.9), "p99": at(0.99) })
}

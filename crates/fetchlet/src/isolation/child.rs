//! The child process of an isolated instance: it builds the engine with a
//! link that sends host operations to the parent, and runs the evaluations
//! the parent sends.

use std::ffi::OsStr;
use std::io::Stdout;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};
use bytes::Bytes;

use fetchlet_web::ByteHandles;

use super::frame::{self, Failure, Frame, Outcome};
use crate::backend::Engine;
use crate::bridge::{Clock, GuestLink, encode_reply};
use crate::config::check_limit;
use crate::execution::WakeSignal;
use crate::{Error, Instance, Limits, Module, Result};

/// The first argument that starts an executable as an isolated instance.
pub(crate) const CHILD_ARGUMENT: &str = "--fetchlet-isolated-instance";

/// Serve as an isolated instance when the parent started this process as
/// one, and never return; otherwise return at once. An executable that
/// [`Program`](crate::Program) names calls this first thing in `main`,
/// before it reads its own arguments or writes to standard output, which
/// carries the frames to the parent.
pub fn serve_if_child() {
    if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(CHILD_ARGUMENT)) {
        return;
    }
    // The engine runs on a thread of the size Rust gives spawned threads,
    // as an in-process engine does, rather than on the main thread, whose
    // size the platform sets (1 MiB on Windows).
    let served = thread::Builder::new()
        .name("fetchlet-isolated-engine".into())
        .spawn(serve)
        .map_err(anyhow::Error::from)
        .and_then(|engine| {
            engine
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("the engine thread panicked")))
        });
    let code = match served {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("fetchlet isolated instance: {error:#}");
            1
        }
    };
    std::process::exit(code);
}

fn serve() -> anyhow::Result<()> {
    let mut input = std::io::stdin();
    let init = match frame::read(&mut input)? {
        Some(Frame::Init(init)) => init,
        _ => bail!("the parent sent no configuration"),
    };

    let (replies, received) = mpsc::channel();
    let (commands, next_command) = mpsc::channel();
    let wake = WakeSignal::default();
    let reader_wake = wake.clone();
    thread::Builder::new()
        .name("fetchlet-isolated-input".into())
        .spawn(move || {
            let mut input = std::io::stdin();
            // The parent closing its end, or anything unreadable, ends the
            // instance: the command channel closes and the main loop returns.
            while let Ok(Some(frame)) = frame::read(&mut input) {
                let sent = match frame {
                    Frame::Wake => {
                        reader_wake.notify();
                        Ok(())
                    }
                    command @ (Frame::Evaluate { .. } | Frame::Call { .. }) => {
                        commands.send(command).map_err(drop)
                    }
                    reply => replies.send(reply).map_err(drop),
                };
                if sent.is_err() {
                    break;
                }
            }
        })
        .context("start the input thread")?;

    let link = Arc::new(RemoteLink {
        output: Mutex::new(std::io::stdout()),
        replies: Mutex::new(received),
        wake,
        limits: init.limits.clone(),
        clock: Clock::default(),
    });
    let module = Module::new(init.source).requires(init.requirements);
    let built = Engine::new(
        init.backend,
        &module,
        GuestLink::Remote(link.clone()),
        Arc::default(),
        &init.limits,
    );
    let mut engine = match built {
        Ok(engine) => {
            link.send(&Frame::Ready)?;
            engine
        }
        Err(error) => {
            link.send(&Frame::Failed(Failure::from(&error)))?;
            return Ok(());
        }
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    while let Ok(command) = next_command.recv() {
        let result = match command {
            Frame::Evaluate {
                expression,
                timeout_micros,
            } => {
                let deadline =
                    timeout_micros.map(|micros| Instant::now() + Duration::from_micros(micros));
                runtime.block_on(engine.evaluate(expression, deadline))
            }
            Frame::Call { export, args } => runtime.block_on(engine.call_json(&export, &args)),
            _ => continue,
        };
        link.send(&Frame::Outcome {
            outcome: Outcome::from_result(result),
            reusable: engine.is_reusable(),
        })?;
    }
    Ok(())
}

/// The child's end of the bridge: host operations and the byte store go to
/// the parent, one request at a time, and wakes come from it. Operations
/// that carry no authority, URL parsing, URL patterns, crypto and the
/// clock, run here without a round trip
/// (docs/research/process-isolation.md#what-it-adds-to-a-page).
pub(crate) struct RemoteLink {
    output: Mutex<Stdout>,
    /// Replies from the parent, in the order of the requests.
    replies: Mutex<mpsc::Receiver<Frame>>,
    wake: WakeSignal,
    limits: Limits,
    clock: Clock,
}

impl RemoteLink {
    fn send(&self, frame: &Frame) -> std::io::Result<()> {
        let mut output = self
            .output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        frame::write(&mut *output, frame)
    }

    /// Send a request and wait for its reply. The lock on the replies keeps
    /// each reply with its request when several threads of the engine ask.
    fn request(&self, frame: &Frame) -> Result<Frame> {
        let replies = self
            .replies
            .lock()
            .map_err(|_| Error::InstanceUnavailable)?;
        self.send(frame).map_err(|_| Error::InstanceUnavailable)?;
        replies.recv().map_err(|_| Error::InstanceUnavailable)
    }

    pub fn dispatch(&self, operation: String, input: String) -> String {
        if let Some(reply) = self.local(&operation, &input) {
            return reply;
        }
        match self.request(&Frame::Dispatch { operation, input }) {
            Ok(Frame::Reply(reply)) => reply,
            Ok(_) => encode_reply(Err(Error::InstanceUnavailable)).to_string(),
            Err(error) => encode_reply(Err(error)).to_string(),
        }
    }

    /// An operation this process can answer as the parent would, or None.
    fn local(&self, operation: &str, input: &str) -> Option<String> {
        if operation == "clock" {
            return Some(encode_reply(Ok(self.clock.read())).to_string());
        }
        let namespace = operation.split('.').next()?;
        if !matches!(namespace, "url" | "urlpattern" | "crypto" | "nodeCrypto") {
            return None;
        }
        // The same check the parent's dispatcher makes first.
        if let Err(error) = check_limit(
            self.limits.bridge_message_bytes,
            input.len(),
            "bridge message bytes",
        ) {
            return Some(encode_reply(Err(error)).to_string());
        }
        let result = fetchlet_web::dispatch::<NoBytes>(operation, input, &self.limits.web(), None)?;
        Some(encode_reply(result).to_string())
    }

    pub fn put_guest_bytes(&self, bytes: &[u8]) -> Result<u64> {
        match self.request(&Frame::PutBytes(bytes.to_vec()))? {
            Frame::Handle(Ok(handle)) => Ok(handle),
            Frame::Handle(Err(failure)) => Err(failure.into_error()),
            _ => Err(Error::InstanceUnavailable),
        }
    }

    pub fn take_guest_bytes(&self, handle: f64) -> Result<Bytes> {
        match self.request(&Frame::TakeBytes(handle))? {
            Frame::Bytes(Ok(bytes)) => Ok(Bytes::from(bytes)),
            Frame::Bytes(Err(failure)) => Err(failure.into_error()),
            _ => Err(Error::InstanceUnavailable),
        }
    }

    pub fn wake_signal(&self) -> WakeSignal {
        self.wake.clone()
    }
}

/// The byte store of operations that run without an invocation, which none
/// of the local ones use.
struct NoBytes;

impl ByteHandles for NoBytes {
    type Error = Error;

    fn put(&mut self, _bytes: Bytes) -> Result<u64> {
        Err(Error::InvocationClosed)
    }

    fn take(&mut self, _handle: u64) -> Result<Bytes> {
        Err(Error::InvocationClosed)
    }
}

//! The parent's end of an isolated instance: it starts the child, answers
//! its host operations from a thread of its own with the App's bridge, and
//! stops the child when a call's deadline, busy timeout or cancellation
//! requires it.

use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use super::child::CHILD_ARGUMENT;
use super::frame::{self, Failure, Frame, Init};
use super::options::{ProcessOptions, Program};
use crate::bridge::HostBridge;
use crate::execution::{Interrupted, StopReason, WakeSignal};
use crate::{Backend, Error, Limits, Module, Result};

/// The reason an isolated instance's process ended, which the call that
/// was running reports. `App` passes it through as the call's error.
#[derive(Debug)]
pub(crate) struct ProcessEnded(pub Error);

impl std::fmt::Display for ProcessEnded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for ProcessEnded {}

/// Who waits for the child's next result.
enum Waiter {
    Startup(mpsc::Sender<Frame>),
    Call(oneshot::Sender<Frame>),
}

/// State the parent's reader thread shares with the engine.
struct Shared {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    waiter: Mutex<Option<Waiter>>,
    /// When the child last sent a frame. A child that sends none for the
    /// busy timeout is running JavaScript that does not return.
    activity: Mutex<Instant>,
    /// The caller's runtime, which host operations run in, as they do on
    /// the caller's thread in-process.
    runtime: Mutex<Option<Handle>>,
    /// Why the child ended, once it has.
    ended: Mutex<Option<Error>>,
    #[cfg(windows)]
    job: super::job::Job,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    fn send(&self, frame: &Frame) -> std::io::Result<()> {
        frame::write(&mut *lock(&self.input), frame)
    }

    fn kill(&self) {
        let _ = lock(&self.child).kill();
    }

    /// Whether the child reached its memory budget.
    fn exceeded_memory(&self) -> bool {
        #[cfg(windows)]
        {
            self.job.exceeded_memory()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    /// Deliver a result to whoever waits for it.
    fn deliver(&self, frame: Frame) -> bool {
        match lock(&self.waiter).take() {
            Some(Waiter::Startup(sender)) => sender.send(frame).is_ok(),
            Some(Waiter::Call(sender)) => sender.send(frame).is_ok(),
            None => false,
        }
    }
}

pub(crate) struct ProcessEngine {
    shared: Arc<Shared>,
    /// The App bridge's notification, forwarded to the child while a call
    /// runs.
    wake: WakeSignal,
    busy: Option<Duration>,
    grace: Duration,
    reusable: bool,
}

impl ProcessEngine {
    pub fn new(
        options: &ProcessOptions,
        backend: Backend,
        module: &Module,
        host: HostBridge,
        limits: &Limits,
    ) -> Result<Self> {
        options.validate()?;
        let program = match &options.program {
            Program::CurrentExe => std::env::current_exe().map_err(|error| {
                Error::Configuration(format!("cannot find this executable: {error}"))
            })?,
            Program::Path(path) => path.clone(),
        };
        let mut child = Command::new(&program)
            .arg(CHILD_ARGUMENT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                Error::Configuration(format!(
                    "cannot start {} as an isolated instance: {error}",
                    program.display()
                ))
            })?;
        // The job bounds the child before it receives anything to run, and
        // ends it with the parent.
        #[cfg(windows)]
        let job = match super::job::Job::new(options.memory_bytes)
            .and_then(|job| job.assign(&child).map(|()| job))
        {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(Error::Configuration(format!(
                    "cannot bound the isolated instance: {error}"
                )));
            }
        };
        let input = child.stdin.take().expect("piped");
        let output = child.stdout.take().expect("piped");
        let (startup, started) = mpsc::channel();
        let shared = Arc::new(Shared {
            child: Mutex::new(child),
            input: Mutex::new(input),
            waiter: Mutex::new(Some(Waiter::Startup(startup))),
            activity: Mutex::new(Instant::now()),
            runtime: Mutex::new(Handle::try_current().ok()),
            ended: Mutex::new(None),
            #[cfg(windows)]
            job,
        });
        let wake = host.wake_signal();
        let reader = shared.clone();
        thread::Builder::new()
            .name("fetchlet-isolated-host".into())
            .spawn(move || serve_child(&reader, output, &host))
            .map_err(|error| Error::Configuration(format!("cannot start a thread: {error}")))?;

        let init = Init {
            backend,
            source: module.source().to_owned(),
            requirements: module.requirements().clone().without_preemption(),
            limits: limits.clone(),
        };
        // A child that cannot read its configuration has ended; the reader
        // reports why.
        let _ = shared.send(&Frame::Init(Box::new(init)));
        let waited = match limits.startup_timeout {
            Some(timeout) => started.recv_timeout(timeout + options.kill_grace),
            None => started
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        let engine = Self {
            shared,
            wake,
            busy: limits.busy_timeout,
            grace: options.kill_grace,
            reusable: true,
        };
        match waited {
            Ok(Frame::Ready) => Ok(engine),
            Ok(Frame::Failed(failure)) => Err(failure.into_error()),
            Ok(_) => Err(Error::InstanceLost("unexpected frame at startup".into())),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                engine.shared.kill();
                Err(Interrupted(StopReason::Startup).into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(engine.ended()),
        }
    }

    /// Why the child ended, after the reader saw it go.
    fn ended(&self) -> Error {
        match lock(&self.shared.ended).as_ref() {
            Some(Error::LimitExceeded(resource)) => Error::LimitExceeded(resource),
            Some(Error::InstanceLost(detail)) => Error::InstanceLost(detail.clone()),
            Some(error) => Error::InstanceLost(error.to_string()),
            None => Error::InstanceLost("the process ended".into()),
        }
    }

    pub fn is_reusable(&self) -> bool {
        self.reusable && lock(&self.shared.ended).is_none()
    }

    pub async fn evaluate(
        &mut self,
        expression: String,
        deadline: Option<Instant>,
    ) -> anyhow::Result<Value> {
        let timeout_micros = deadline.map(|deadline| {
            let left = deadline.saturating_duration_since(Instant::now());
            u64::try_from(left.as_micros()).unwrap_or(u64::MAX)
        });
        self.run(Frame::Evaluate {
            expression,
            timeout_micros,
        })
        .await
    }

    pub async fn call_json(&mut self, export: &str, args: &[Value]) -> anyhow::Result<Value> {
        self.run(Frame::Call {
            export: export.to_owned(),
            args: args.to_vec(),
        })
        .await
    }

    /// Send one evaluation and wait for its outcome, forwarding wakes. If
    /// the caller drops this future, at a deadline or on cancellation, the
    /// child ends with it.
    async fn run(&mut self, request: Frame) -> anyhow::Result<Value> {
        if !self.is_reusable() {
            return Err(Error::InstanceUnavailable.into());
        }
        self.reusable = false;
        let (sender, mut outcome) = oneshot::channel();
        *lock(&self.shared.waiter) = Some(Waiter::Call(sender));
        *lock(&self.shared.runtime) = Handle::try_current().ok();
        *lock(&self.shared.activity) = Instant::now();
        let mut guard = KillOnDrop(Some(self.shared.clone()));
        if self.shared.send(&request).is_err() {
            guard.0 = None;
            self.shared.kill();
        }
        let busy = self.busy.map(|busy| busy + self.grace);
        let mut stopped = None;
        let frame = loop {
            let quiet_for = lock(&self.shared.activity).elapsed();
            let check = busy.map(|busy| busy.saturating_sub(quiet_for));
            tokio::select! {
                frame = &mut outcome => break frame,
                () = self.wake.wait(None) => {
                    let _ = self.shared.send(&Frame::Wake);
                }
                () = sleep_or_forever(check) => {
                    if busy.is_some_and(|busy| lock(&self.shared.activity).elapsed() >= busy) {
                        stopped = Some(StopReason::Busy);
                        self.shared.kill();
                    }
                }
            }
        };
        guard.0 = None;
        match frame {
            Ok(Frame::Outcome { outcome, reusable }) => {
                if self.shared.exceeded_memory() {
                    // QuickJS reports a failed allocation as an exception;
                    // the budget is the process's, so the instance retires.
                    self.shared.kill();
                    return Err(ProcessEnded(Error::LimitExceeded("process memory")).into());
                }
                self.reusable = reusable;
                outcome.into_result()
            }
            Ok(_) => {
                self.shared.kill();
                Err(ProcessEnded(Error::InstanceLost("unexpected frame".into())).into())
            }
            Err(_) => match stopped {
                Some(reason) => Err(Interrupted(reason).into()),
                None => Err(ProcessEnded(self.ended()).into()),
            },
        }
    }
}

impl Drop for ProcessEngine {
    fn drop(&mut self) {
        self.shared.kill();
    }
}

/// Ends the child when a call's future is dropped before its outcome.
struct KillOnDrop(Option<Arc<Shared>>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(shared) = self.0.take() {
            shared.kill();
        }
    }
}

async fn sleep_or_forever(duration: Option<Duration>) {
    match duration {
        Some(duration) => tokio::time::sleep(duration).await,
        None => std::future::pending().await,
    }
}

/// The parent's reader: answer the child's host operations with the App's
/// bridge, hand results to their waiter, and record why the child ended.
/// Anything the child sends is untrusted, as guest input is: operations go
/// through the same dispatcher and budgets as in-process, and a frame that
/// does not belong ends the child.
fn serve_child(shared: &Shared, mut output: ChildStdout, host: &HostBridge) {
    while let Ok(Some(frame)) = frame::read(&mut output) {
        *lock(&shared.activity) = Instant::now();
        let reply = match frame {
            Frame::Dispatch { operation, input } => {
                let runtime = lock(&shared.runtime).clone();
                let _entered = runtime.as_ref().map(Handle::enter);
                Frame::Reply(host.dispatch(operation, input))
            }
            Frame::PutBytes(bytes) => Frame::Handle(
                host.put_guest_bytes(&bytes)
                    .map_err(|error| Failure::from(&error)),
            ),
            Frame::TakeBytes(handle) => Frame::Bytes(
                host.take_guest_bytes(handle)
                    .map(|bytes| bytes.to_vec())
                    .map_err(|error| Failure::from(&error)),
            ),
            result @ (Frame::Ready | Frame::Failed(_) | Frame::Outcome { .. }) => {
                if !shared.deliver(result) {
                    break;
                }
                continue;
            }
            _ => break,
        };
        if shared.send(&reply).is_err() {
            break;
        }
    }
    shared.kill();
    let status = lock(&shared.child).wait();
    let reason = if shared.exceeded_memory() {
        Error::LimitExceeded("process memory")
    } else {
        Error::InstanceLost(describe(status))
    };
    *lock(&shared.ended) = Some(reason);
    // Whoever waits sees the channel close and reads the reason.
    lock(&shared.waiter).take();
}

fn describe(status: std::io::Result<ExitStatus>) -> String {
    match status {
        Ok(status) => format!("the process exited with {status}"),
        Err(error) => format!("the process could not be waited for: {error}"),
    }
}

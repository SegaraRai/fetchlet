use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};

use anyhow::{Result, anyhow};
use deno_core::v8;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use super::V8Options;
use super::runtime::V8Runtime;
use super::watchdog::{IsolateSlot, Watchdog};
use crate::Instance;
use crate::backend::Startup;
use crate::bridge::HostBridge;
use crate::execution::{Interrupt, Interrupted, WakeSignal, invocation};

struct Call {
    expression: String,
    cancelled: Arc<AtomicBool>,
    /// The caller's runtime, which runs what host futures spawn.
    runtime: Option<Handle>,
    reply: oneshot::Sender<(Result<Value>, bool)>,
}

/// The worker owns its isolate and exchanges JSON values with the caller.
pub struct V8 {
    sender: mpsc::Sender<Option<Call>>,
    worker: Option<JoinHandle<()>>,
    isolate: v8::IsolateHandle,
    interrupt: Interrupt,
    /// Terminates the isolate past the busy timeout; None without one.
    /// Dropped before the worker is joined.
    watchdog: Option<Watchdog>,
    poisoned: bool,
    wake: WakeSignal,
}

impl V8 {
    pub fn new(source: &str) -> Result<Self> {
        Self::with_options(source, V8Options::default())
    }

    pub fn with_options(source: &str, options: V8Options) -> Result<Self> {
        Self::with_host(&Startup::unchecked(source), HostBridge::default(), options)
    }

    pub(crate) fn with_host(
        startup: &Startup<'_>,
        host: HostBridge,
        options: V8Options,
    ) -> Result<Self> {
        options.validate()?;
        let wake = host.wake_signal();
        let source = startup.source().to_owned();
        let check = startup.check().clone();
        let code_cache = startup.code_cache().cloned();
        let interrupt = startup.interrupt();
        let slot = IsolateSlot::default();
        let watchdog = Watchdog::start(&interrupt, startup.startup_timeout(), &slot)?;
        let deadline = startup.deadline();
        let worker_interrupt = interrupt.clone();
        let (sender, receiver) = mpsc::channel::<Option<Call>>();
        let (ready, initialized) = mpsc::sync_channel(1);
        let mut worker = thread::Builder::new().name("fetchlet-v8".into());
        if let Some(size) = options.worker_stack_bytes {
            worker = worker.stack_size(size);
        }
        let worker = worker.spawn(move || {
            let executor = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready.send(Err(error.into()));
                    return;
                }
            };
            let _entered = executor.enter();
            let loaded = V8Runtime::new(
                &source,
                &check,
                code_cache.as_deref(),
                host,
                worker_interrupt,
                deadline,
                |isolate| {
                    let _ = slot.set(isolate);
                },
            );
            let mut local = match loaded {
                Ok(local) => local,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            let _ = ready.send(Ok(local.isolate_handle()));
            while let Ok(Some(call)) = receiver.recv() {
                local.set_cancellation(call.cancelled);
                // Host futures run here, but what they spawn, such as a
                // pooled connection another worker reuses, must keep running
                // between calls: it goes to the caller's runtime, whose
                // thread drives its IO and timers while it awaits the reply.
                // The worker's own runtime runs only during a call.
                let result = match call.runtime {
                    Some(runtime) => {
                        let _caller = runtime.enter();
                        runtime.block_on(local.evaluate(call.expression))
                    }
                    None => executor.block_on(local.evaluate(call.expression)),
                };
                let _ = call.reply.send((result, local.is_reusable()));
            }
        })?;
        let isolate = match initialized.recv()? {
            Ok(isolate) => isolate,
            Err(error) => {
                drop(watchdog);
                let _ = worker.join();
                return Err(match interrupt.stopped() {
                    Some(reason) => Interrupted(reason).into(),
                    None => error,
                });
            }
        };
        Ok(Self {
            sender,
            worker: Some(worker),
            isolate,
            interrupt,
            watchdog,
            poisoned: false,
            wake,
        })
    }
}

impl Instance for V8 {
    fn is_reusable(&self) -> bool {
        !self.poisoned
    }

    async fn call_json(&mut self, export: &str, args: &[Value]) -> Result<Value> {
        self.evaluate_until(invocation(export, args)?, None).await
    }
}

impl V8 {
    /// Evaluate an invocation expression on the isolate's worker thread.
    /// The caller's timer terminates the isolate at `deadline` by dropping
    /// the call; the watchdog terminates it past the busy timeout, or at
    /// `deadline` when it checks first. A stopped instance is not reusable.
    pub(crate) async fn evaluate_until(
        &mut self,
        expression: String,
        deadline: Option<std::time::Instant>,
    ) -> Result<Value> {
        self.interrupt.arm(deadline);
        let result = self.evaluate(expression).await;
        self.interrupt.disarm();
        // A stop the watchdog recorded retires the instance even if the
        // evaluation finished first: its termination may still be pending.
        match self.interrupt.stopped() {
            Some(reason) => {
                self.poisoned = true;
                Err(Interrupted(reason).into())
            }
            None => result,
        }
    }

    async fn evaluate(&mut self, expression: String) -> Result<Value> {
        if self.poisoned {
            anyhow::bail!("Instance cannot be reused after an interrupted call");
        }
        self.poisoned = true;
        let flag = Arc::new(AtomicBool::new(false));
        let mut cancellation = Cancellation {
            flag: flag.clone(),
            isolate: self.isolate.clone(),
            armed: true,
            wake: self.wake.clone(),
        };
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Some(Call {
                expression,
                cancelled: flag,
                runtime: Handle::try_current().ok(),
                reply,
            }))
            .map_err(|_| anyhow!("V8 worker stopped"))?;
        let (result, reusable) = receive.await.map_err(|_| anyhow!("V8 worker stopped"))?;
        cancellation.armed = false;
        self.poisoned = !reusable;
        result
    }
}

impl Drop for V8 {
    fn drop(&mut self) {
        drop(self.watchdog.take());
        let _ = self.sender.send(None);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Cancellation {
    flag: Arc<AtomicBool>,
    isolate: v8::IsolateHandle,
    armed: bool,
    wake: WakeSignal,
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        if self.armed {
            self.flag.store(true, Ordering::Relaxed);
            self.isolate.terminate_execution();
            self.wake.notify();
        }
    }
}

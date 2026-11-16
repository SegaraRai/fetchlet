use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};

use anyhow::{Result, anyhow};
use deno_core::v8;
use serde_json::Value;
use tokio::sync::oneshot;

use super::V8Options;
use super::runtime::V8Runtime;
use crate::Instance;
use crate::bridge::HostBridge;
use crate::execution::WakeSignal;

struct Call {
    export: String,
    args: Vec<Value>,
    cancelled: Arc<AtomicBool>,
    reply: oneshot::Sender<(Result<Value>, bool)>,
}

/// The worker owns its isolate and exchanges JSON values with the caller.
pub struct V8 {
    sender: mpsc::Sender<Option<Call>>,
    worker: Option<JoinHandle<()>>,
    isolate: v8::IsolateHandle,
    poisoned: bool,
    wake: WakeSignal,
}

impl V8 {
    pub fn new(source: &str) -> Result<Self> {
        Self::with_options(source, V8Options::default())
    }

    pub fn with_options(source: &str, options: V8Options) -> Result<Self> {
        Self::with_host(source, HostBridge::default(), options)
    }

    pub(crate) fn with_host(source: &str, host: HostBridge, options: V8Options) -> Result<Self> {
        options.validate()?;
        let wake = host.wake_signal();
        let source = source.to_owned();
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
                    let _ = ready.send(Err(error.to_string()));
                    return;
                }
            };
            let _entered = executor.enter();
            let mut local = match V8Runtime::new(&source, host) {
                Ok(local) => local,
                Err(error) => {
                    let _ = ready.send(Err(format!("{error:#}")));
                    return;
                }
            };
            let _ = ready.send(Ok(local.isolate_handle()));
            while let Ok(Some(call)) = receiver.recv() {
                local.set_cancellation(call.cancelled);
                let result = executor.block_on(local.call_json(&call.export, &call.args));
                let _ = call.reply.send((result, local.is_reusable()));
            }
        })?;
        let isolate = initialized.recv()?.map_err(|error| anyhow!(error))?;
        Ok(Self {
            sender,
            worker: Some(worker),
            isolate,
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
                export: export.to_owned(),
                args: args.to_vec(),
                cancelled: flag,
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

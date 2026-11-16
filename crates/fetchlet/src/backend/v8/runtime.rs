use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, anyhow};
use deno_core::{JsRuntime, OpState, RuntimeOptions, v8};
use deno_error::JsErrorBox;
use serde_json::Value;

use crate::Instance;
use crate::bridge::HostBridge;
use crate::execution::{HOST_BOOTSTRAP, LOOP_STEP, LoopState, PRELUDE, WakeSignal, invocation};

pub(super) struct V8Runtime {
    runtime: JsRuntime,
    cancelled: Arc<AtomicBool>,
    reusable: bool,
    wake: WakeSignal,
}

#[deno_core::op2]
#[string]
fn op_fetchlet_host(state: &mut OpState, #[string] op: String, #[string] input: String) -> String {
    state.borrow::<HostBridge>().dispatch(op, input)
}

/// A Uint8Array with bytes that Rust stored in the current invocation.
#[deno_core::op2]
#[buffer]
fn op_fetchlet_take_bytes(state: &mut OpState, handle: f64) -> Result<Vec<u8>, JsErrorBox> {
    state
        .borrow::<HostBridge>()
        .take_guest_bytes(handle)
        .map(|bytes| bytes.to_vec())
        .map_err(|error| JsErrorBox::type_error(error.guest_message()))
}

/// Copy a Uint8Array into the current invocation's store; returns its handle.
#[deno_core::op2(fast)]
fn op_fetchlet_put_bytes(state: &mut OpState, #[buffer] bytes: &[u8]) -> Result<f64, JsErrorBox> {
    state
        .borrow::<HostBridge>()
        .put_guest_bytes(bytes)
        .map(|handle| handle as f64)
        .map_err(|error| JsErrorBox::type_error(error.guest_message()))
}

deno_core::extension!(
    fetchlet_host,
    ops = [
        op_fetchlet_host,
        op_fetchlet_take_bytes,
        op_fetchlet_put_bytes
    ]
);

impl V8Runtime {
    pub(super) fn isolate_handle(&mut self) -> v8::IsolateHandle {
        self.runtime.v8_isolate().thread_safe_handle()
    }

    pub(super) fn set_cancellation(&mut self, flag: Arc<AtomicBool>) {
        self.cancelled = flag;
    }

    pub(super) fn new(source: &str, host: HostBridge) -> Result<Self> {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![fetchlet_host::init()],
            ..Default::default()
        });
        let wake = host.wake_signal();
        runtime.op_state().borrow_mut().put(host);
        runtime
            .execute_script(
                "fetchlet:host",
                "globalThis.__fetchletHost=Deno.core.ops.op_fetchlet_host;\
                 globalThis.__fetchletTakeBytes=Deno.core.ops.op_fetchlet_take_bytes;\
                 globalThis.__fetchletPutBytes=Deno.core.ops.op_fetchlet_put_bytes;",
            )
            .map_err(|error| anyhow!("{error}"))?;
        runtime
            .execute_script("fetchlet:prelude", PRELUDE)
            .map_err(|error| anyhow!("{error}"))?;
        runtime
            .execute_script("fetchlet:bridge", HOST_BOOTSTRAP)
            .map_err(|error| anyhow!("{error}"))?;
        runtime
            .execute_script("fetchlet:bundle", source.to_owned())
            .map_err(|error| anyhow!("{error}"))?;
        Ok(Self {
            runtime,
            cancelled: Arc::new(AtomicBool::new(false)),
            reusable: true,
            wake,
        })
    }
}

impl Instance for V8Runtime {
    fn is_reusable(&self) -> bool {
        self.reusable
    }

    async fn call_json(&mut self, export: &str, args: &[Value]) -> Result<Value> {
        self.evaluate(invocation(export, args)?).await
    }
}

impl V8Runtime {
    /// Evaluate an invocation expression and drive its Promise to completion.
    /// The invocation script owns timer and response-body cleanup.
    pub(super) async fn evaluate(&mut self, expression: String) -> Result<Value> {
        self.reusable = false;
        let promise = self
            .runtime
            .execute_script("fetchlet:call", expression)
            .map_err(|error| anyhow!("{error}"))?;
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                anyhow::bail!("Invocation cancelled");
            }
            self.runtime.v8_isolate().perform_microtask_checkpoint();
            let result = {
                deno_core::scope!(scope, &mut self.runtime);
                let local = v8::Local::new(scope, promise.clone());
                let promise = v8::Local::<v8::Promise>::try_from(local)
                    .map_err(|_| anyhow!("Expected promise"))?;
                match promise.state() {
                    v8::PromiseState::Pending => None,
                    v8::PromiseState::Fulfilled => {
                        Some(Ok(promise.result(scope).to_rust_string_lossy(scope)))
                    }
                    v8::PromiseState::Rejected => Some(Err(anyhow!(
                        "{}",
                        promise.result(scope).to_rust_string_lossy(scope)
                    ))),
                }
            };
            if let Some(json) = result {
                self.reusable = true;
                return Ok(serde_json::from_str(&json?)?);
            }
            let state = self
                .runtime
                .execute_script("fetchlet:tick", LOOP_STEP)
                .map_err(|error| anyhow!("{error}"))?;
            let state = {
                deno_core::scope!(scope, &mut self.runtime);
                v8::Local::new(scope, state).to_rust_string_lossy(scope)
            };
            let state: LoopState = serde_json::from_str(&state)?;

            if state.progress {
                tokio::task::yield_now().await;
            } else {
                self.wake.wait(state.timer_delay()).await;
            }
        }
    }
}

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, anyhow};
use deno_core::{JsRuntime, OpState, RuntimeOptions, v8};
use deno_error::JsErrorBox;
use serde_json::Value;

use crate::Instance;
use crate::backend::Check;
use crate::bridge::HostBridge;
use crate::execution::{
    FLUSH_REJECTIONS, HOST_BOOTSTRAP, LOOP_STEP, LoopState, PRELUDE, SEAL_HOST, WakeSignal,
    invocation, observed,
};

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

    pub(super) fn new(source: &str, check: &Check, host: HostBridge) -> Result<Self> {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![fetchlet_host::init()],
            ..Default::default()
        });
        // fetchlet drives microtasks itself rather than through deno_core's
        // event loop, so the profile, not deno_core, tracks rejections.
        runtime
            .v8_isolate()
            .set_promise_reject_callback(track_rejection);
        let wake = host.wake_signal();
        runtime.op_state().borrow_mut().put(host);
        // The async context slot is V8's continuation-preserved embedder
        // data, which V8 captures with each promise reaction and restores
        // when the reaction runs.
        //
        // `Deno.core` also carries deno_core's built-in ops, such as
        // `op_panic`, which aborts the process, and `op_print`, which writes
        // to its stdout. The guest receives only fetchlet's operations;
        // deno_core reads `Deno.core` while the runtime is created, and Deno
        // itself removes it after bootstrap in the same way.
        runtime
            .execute_script(
                "fetchlet:host",
                "globalThis.__fetchletHost=Deno.core.ops.op_fetchlet_host;\
                 globalThis.__fetchletTakeBytes=Deno.core.ops.op_fetchlet_take_bytes;\
                 globalThis.__fetchletPutBytes=Deno.core.ops.op_fetchlet_put_bytes;\
                 globalThis.__fetchletAsyncContext={get:Deno.core.getAsyncContext,set:Deno.core.setAsyncContext};\
                 delete globalThis.Deno;\
                 delete globalThis.__bootstrap;",
            )
            .map_err(|error| anyhow!("{error}"))?;
        runtime
            .execute_script("fetchlet:prelude", PRELUDE)
            .map_err(|error| anyhow!("{error}"))?;
        runtime
            .execute_script("fetchlet:bridge", HOST_BOOTSTRAP)
            .map_err(|error| anyhow!("{error}"))?;
        let report = match check.probe() {
            Some(probe) => {
                let value = runtime
                    .execute_script("fetchlet:probe", probe.to_owned())
                    .map_err(|error| anyhow!("{error}"))?;
                deno_core::scope!(scope, &mut runtime);
                Some(v8::Local::new(scope, value).to_rust_string_lossy(scope))
            }
            None => None,
        };
        check.admit(report.as_deref())?;
        runtime
            .execute_script("fetchlet:bundle", source.to_owned())
            .map_err(|error| anyhow!("{error}"))?;
        runtime
            .execute_script("fetchlet:seal", SEAL_HOST)
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
            .execute_script("fetchlet:call", observed(&expression))
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
                self.flush_rejections();
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

impl V8Runtime {
    /// Notify unhandled rejections once an invocation settles, and run the
    /// microtasks their listeners queue.
    fn flush_rejections(&mut self) {
        let _ = self
            .runtime
            .execute_script("fetchlet:rejections", FLUSH_REJECTIONS);
        self.runtime.v8_isolate().perform_microtask_checkpoint();
    }
}

/// HostPromiseRejectionTracker: hands each rejection without a handler, and
/// each handler added after one, to the profile's tracking hook.
extern "C" fn track_rejection(message: v8::PromiseRejectMessage) {
    let handled = match message.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => false,
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => true,
        _ => return,
    };
    // SAFETY: the message is valid for the duration of the callback.
    v8::callback_scope!(unsafe scope, &message);
    let context = scope.get_current_context();
    let global = context.global(scope);
    let Some(name) = v8::String::new(scope, "__fetchletPromiseRejection") else {
        return;
    };
    let Some(hook) = global
        .get(scope, name.into())
        .and_then(|hook| v8::Local::<v8::Function>::try_from(hook).ok())
    else {
        return;
    };
    let promise = message.get_promise();
    // V8 passes no value with a handler added after the rejection; the
    // rejected promise still holds its reason.
    let reason = message.get_value().unwrap_or_else(|| promise.result(scope));
    let handled = v8::Boolean::new(scope, handled);
    v8::tc_scope!(let scope, scope);
    hook.call(
        scope,
        global.into(),
        &[promise.into(), reason, handled.into()],
    );
}

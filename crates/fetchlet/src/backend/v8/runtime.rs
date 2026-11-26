use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, anyhow};
use deno_core::{JsRuntime, OpState, RuntimeOptions, v8};
use deno_error::JsErrorBox;
use serde_json::Value;

use super::{V8Options, heap};
use crate::Instance;
use crate::backend::{Check, CodeCache, Script};
use crate::bridge::GuestLink;
use crate::execution::{
    FLUSH_REJECTIONS, HOST_BOOTSTRAP, Interrupt, Interrupted, LOOP_STEP, LoopState, PRELUDE,
    SEAL_HOST, WakeSignal, invocation, observed,
};

/// The engine name compiled code is cached under.
const ENGINE: &str = "v8";

/// Run a script as `JsRuntime::execute_script` does, consuming the
/// application's code cache for it when another instance made one. Without
/// one, or when V8 refuses it, the script compiles from source and its cache
/// is made after it ran, so that it holds the functions the run compiled
/// too: V8 compiles a function only when it is first called.
fn execute_script(
    runtime: &mut JsRuntime,
    cache: Option<&CodeCache>,
    script: Script,
    name: &'static str,
    source: &str,
) -> Result<()> {
    let Some(cache) = cache else {
        runtime
            .execute_script(name, source.to_owned())
            .map_err(|error| anyhow!("{error}"))?;
        return Ok(());
    };
    let cached = cache.get(ENGINE, script);
    deno_core::scope!(scope, runtime);
    let code = v8::String::new(scope, source).ok_or_else(|| anyhow!("{name} is too long"))?;
    let resource = v8::String::new(scope, name).ok_or_else(|| anyhow!("{name} is too long"))?;
    let origin = v8::ScriptOrigin::new(
        scope,
        resource.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    v8::tc_scope!(let tc, scope);
    let (compiled, consumed) = match &cached {
        Some(data) => {
            let mut source = v8::script_compiler::Source::new_with_cached_data(
                code,
                Some(&origin),
                v8::CachedData::new(data),
            );
            let compiled = v8::script_compiler::compile(
                tc,
                &mut source,
                v8::script_compiler::CompileOptions::ConsumeCodeCache,
                v8::script_compiler::NoCacheReason::NoReason,
            );
            let accepted = source
                .get_cached_data()
                .is_some_and(|data| !data.rejected());
            (compiled, accepted)
        }
        None => (v8::Script::compile(tc, code, Some(&origin)), false),
    };
    let Some(compiled) = compiled else {
        let exception = tc
            .exception()
            .ok_or_else(|| anyhow!("{name} did not compile"))?;
        return Err(anyhow!(
            "{}",
            deno_core::error::exception_to_err(tc, exception, false, false)
        ));
    };
    if compiled.run(tc).is_none() {
        let exception = tc
            .exception()
            .ok_or_else(|| anyhow!("{name} was terminated"))?;
        return Err(anyhow!(
            "{}",
            deno_core::error::exception_to_err(tc, exception, false, false)
        ));
    }
    if !consumed && let Some(data) = compiled.get_unbound_script(tc).create_code_cache() {
        cache.put(ENGINE, script, &data);
    }
    Ok(())
}

pub(super) struct V8Runtime {
    runtime: JsRuntime,
    cancelled: Arc<AtomicBool>,
    interrupt: Interrupt,
    reusable: bool,
    wake: WakeSignal,
}

#[deno_core::op2]
#[string]
fn op_fetchlet_host(state: &mut OpState, #[string] op: String, #[string] input: String) -> String {
    state.borrow::<GuestLink>().dispatch(op, input)
}

/// A Uint8Array with bytes that Rust stored in the current invocation.
#[deno_core::op2]
#[buffer]
fn op_fetchlet_take_bytes(state: &mut OpState, handle: f64) -> Result<Vec<u8>, JsErrorBox> {
    state
        .borrow::<GuestLink>()
        .take_guest_bytes(handle)
        .map(|bytes| bytes.to_vec())
        .map_err(|error| JsErrorBox::type_error(error.guest_message()))
}

/// Copy a Uint8Array into the current invocation's store; returns its handle.
#[deno_core::op2(fast)]
fn op_fetchlet_put_bytes(state: &mut OpState, #[buffer] bytes: &[u8]) -> Result<f64, JsErrorBox> {
    state
        .borrow::<GuestLink>()
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

    /// Create the isolate with the heap limit `heap`, hand its handle to
    /// `on_isolate` so that a watchdog can terminate it, and evaluate the
    /// module, which `interrupt` stops at `deadline`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        source: &str,
        check: &Check,
        cache: Option<&CodeCache>,
        host: GuestLink,
        options: &V8Options,
        heap: Option<usize>,
        interrupt: Interrupt,
        deadline: Option<std::time::Instant>,
        on_isolate: impl FnOnce(v8::IsolateHandle),
    ) -> Result<Self> {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![fetchlet_host::init()],
            create_params: heap::create_params(heap, options),
            ..Default::default()
        });
        heap::watch(&mut runtime, heap, interrupt.clone());
        on_isolate(runtime.v8_isolate().thread_safe_handle());
        interrupt.arm_startup(deadline);
        let loaded = Self::load(&mut runtime, source, check, cache, host);
        interrupt.disarm();
        let wake = loaded?;
        Ok(Self {
            runtime,
            cancelled: Arc::new(AtomicBool::new(false)),
            interrupt,
            reusable: true,
            wake,
        })
    }

    /// Install the host and evaluate the scripts and the module.
    fn load(
        runtime: &mut JsRuntime,
        source: &str,
        check: &Check,
        cache: Option<&CodeCache>,
        host: GuestLink,
    ) -> Result<WakeSignal> {
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
        execute_script(runtime, cache, Script::Prelude, "fetchlet:prelude", PRELUDE)?;
        execute_script(
            runtime,
            cache,
            Script::Bridge,
            "fetchlet:bridge",
            HOST_BOOTSTRAP,
        )?;
        let report = match check.probe() {
            Some(probe) => {
                let value = runtime
                    .execute_script("fetchlet:probe", probe.to_owned())
                    .map_err(|error| anyhow!("{error}"))?;
                deno_core::scope!(scope, runtime);
                Some(v8::Local::new(scope, value).to_rust_string_lossy(scope))
            }
            None => None,
        };
        check.admit(report.as_deref())?;
        execute_script(runtime, cache, Script::Module, "fetchlet:bundle", source)?;
        runtime
            .execute_script("fetchlet:seal", SEAL_HOST)
            .map_err(|error| anyhow!("{error}"))?;
        Ok(wake)
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
        // The busy clock runs from each entry into JavaScript, the first
        // evaluation or a return from the loop's wait, until the next wait.
        self.interrupt.enter();
        let promise = self
            .runtime
            .execute_script("fetchlet:call", observed(&expression))
            .map_err(|error| anyhow!("{error}"))?;
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                anyhow::bail!("Invocation cancelled");
            }
            self.runtime.v8_isolate().perform_microtask_checkpoint();
            // V8 ends a termination once no JavaScript runs, so the
            // microtask it stopped is gone and the promise stays pending:
            // the recorded stop ends the evaluation instead of the wait.
            if let Some(reason) = self.interrupt.stopped() {
                return Err(Interrupted(reason).into());
            }
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
            if let Some(reason) = self.interrupt.stopped() {
                return Err(Interrupted(reason).into());
            }

            self.interrupt.leave();
            if state.progress {
                tokio::task::yield_now().await;
            } else {
                self.wake.wait(state.timer_delay()).await;
            }
            self.interrupt.enter();
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

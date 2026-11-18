use std::rc::Rc;

use anyhow::{Result, anyhow};
use boa_engine::builtins::promise::{OperationType, Promise, PromiseState};
use boa_engine::context::HostHooks;
use boa_engine::job::JobCallback;
use boa_engine::object::JsObject;
use boa_engine::object::builtins::JsFunction;
use boa_engine::object::builtins::JsPromise;
use boa_engine::object::builtins::{JsArrayBuffer, JsUint8Array};
use boa_engine::{
    Context, JsArgs, JsData, JsError, JsNativeError, JsResult, JsString, JsValue, NativeFunction,
    Source, js_string,
};
use boa_gc::{Finalize, Trace};
use serde_json::Value;

use super::{BoaOptions, array_buffer};
use crate::Instance;
use crate::bridge::HostBridge;
use crate::execution::{
    FLUSH_REJECTIONS, HOST_BOOTSTRAP, LOOP_STEP, LoopState, PRELUDE, WakeSignal, invocation,
    observed,
};

pub struct Boa {
    context: Context,
    poisoned: bool,
    wake: WakeSignal,
}
struct BoaHost(HostBridge);

impl Boa {
    pub fn new(source: &str) -> Result<Self> {
        Self::with_host(source, HostBridge::default(), BoaOptions::default())
    }

    pub(crate) fn with_host(source: &str, host: HostBridge, options: BoaOptions) -> Result<Self> {
        let mut context = Context::builder()
            .host_hooks(Rc::new(EngineHooks))
            .build()
            .map_err(|error| anyhow!("{error}"))?;
        options.apply(&mut context);
        // Host-defined data contains no JS values and stays with its Context.
        let wake = host.wake_signal();
        context.insert_data(BoaHost(host));
        array_buffer::install(&mut context).map_err(|error| anyhow!("{error}"))?;
        context
            .register_global_callable(
                js_string!("__fetchletHost"),
                2,
                NativeFunction::from_fn_ptr(|_, args, ctx| {
                    let operation = args
                        .get_or_undefined(0)
                        .to_string(ctx)?
                        .to_std_string_escaped();
                    let input = args
                        .get_or_undefined(1)
                        .to_string(ctx)?
                        .to_std_string_escaped();
                    let host = ctx.get_data::<BoaHost>().expect("host installed");
                    Ok(JsString::from(host.0.dispatch(operation, input)).into())
                }),
            )
            .map_err(|error| anyhow!("{error}"))?;
        context
            .register_global_callable(
                js_string!("__fetchletTakeBytes"),
                1,
                NativeFunction::from_fn_ptr(take_bytes),
            )
            .map_err(|error| anyhow!("{error}"))?;
        context
            .register_global_callable(
                js_string!("__fetchletPutBytes"),
                1,
                NativeFunction::from_fn_ptr(put_bytes),
            )
            .map_err(|error| anyhow!("{error}"))?;
        context
            .eval(Source::from_bytes(ASYNC_CONTEXT_SLOT))
            .map_err(|error| anyhow!("{error}"))?;
        context
            .eval(Source::from_bytes(PRELUDE))
            .map_err(|error| anyhow!("{error}"))?;
        context
            .eval(Source::from_bytes(HOST_BOOTSTRAP))
            .map_err(|error| anyhow!("{error}"))?;
        context
            .eval(Source::from_bytes(source))
            .map_err(|error| anyhow!("{error}"))?;
        Ok(Self {
            context,
            poisoned: false,
            wake,
        })
    }
}

impl Instance for Boa {
    fn is_reusable(&self) -> bool {
        !self.poisoned
    }

    async fn call_json(&mut self, export: &str, args: &[Value]) -> Result<Value> {
        self.evaluate(invocation(export, args)?).await
    }
}

impl Boa {
    /// Evaluate an invocation expression and drive its Promise to completion.
    /// The invocation script owns timer and response-body cleanup.
    pub(crate) async fn evaluate(&mut self, expression: String) -> Result<Value> {
        if self.poisoned {
            anyhow::bail!("Instance cannot be reused after an interrupted call");
        }
        self.poisoned = true;
        let result = self
            .context
            .eval(Source::from_bytes(&observed(&expression)))
            .map_err(|error| anyhow!("{error}"))?;
        let promise = result
            .as_promise()
            .ok_or_else(|| anyhow!("Invocation did not return a Promise"))?;
        loop {
            self.context
                .run_jobs()
                .map_err(|error| anyhow!("{error}"))?;
            let state = promise.state();
            if !matches!(state, PromiseState::Pending) {
                self.flush_rejections();
            }
            match state {
                PromiseState::Fulfilled(value) => {
                    self.poisoned = false;
                    let json = value
                        .as_string()
                        .ok_or_else(|| anyhow!("Invocation did not return JSON"))?
                        .to_std_string_escaped();
                    return Ok(serde_json::from_str(&json)?);
                }
                PromiseState::Rejected(value) => {
                    self.poisoned = false;
                    return Err(anyhow!(
                        "{}",
                        value
                            .to_string(&mut self.context)
                            .map_err(|error| anyhow!("{error}"))?
                            .to_std_string_escaped()
                    ));
                }
                PromiseState::Pending => {}
            }
            let state = self
                .context
                .eval(Source::from_bytes(LOOP_STEP))
                .map_err(|error| anyhow!("{error}"))?;
            let state = state
                .to_string(&mut self.context)
                .map_err(|error| anyhow!("{error}"))?
                .to_std_string_escaped();
            let state: LoopState = serde_json::from_str(&state)?;

            if state.progress {
                tokio::task::yield_now().await;
            } else {
                self.wake.wait(state.timer_delay()).await;
            }
        }
    }
}

impl Boa {
    /// Notify unhandled rejections once an invocation settles, and run the
    /// jobs their listeners queue.
    fn flush_rejections(&mut self) {
        let _ = self.context.eval(Source::from_bytes(FLUSH_REJECTIONS));
        let _ = self.context.run_jobs();
    }
}

/// The host hooks: rejection tracking for the profile's global events, and
/// the async context slot carried through promise jobs.
struct EngineHooks;

/// The async context slot. The current mapping lives on an object that the
/// global object holds, where the garbage collector traces it; the hooks
/// read and write it there.
const ASYNC_CONTEXT_SLOT: &str = r#"(() => {
  const slot = {
    mapping: undefined,
  };
  Object.defineProperty(globalThis, "__fetchletAsyncContextSlot", {
    value: slot,
  });
  globalThis.__fetchletAsyncContext = {
    get: () => slot.mapping,
    set: (mapping) => {
      slot.mapping = mapping;
    },
  };
})();"#;

/// The mapping current when a promise reaction was registered.
#[derive(Trace, Finalize, JsData)]
struct CapturedContext(JsValue);

fn async_context_slot(context: &mut Context) -> Option<JsObject> {
    context
        .global_object()
        .get(js_string!("__fetchletAsyncContextSlot"), context)
        .ok()?
        .as_object()
}

impl HostHooks for EngineHooks {
    /// HostMakeJobCallback: Boa calls it whenever a promise reaction is
    /// registered (`then`, `await` and thenable jobs), so the reaction
    /// captures the current mapping, as V8 does with its embedder data.
    fn make_job_callback(&self, callback: JsFunction, context: &mut Context) -> JobCallback {
        let mapping = async_context_slot(context)
            .and_then(|slot| slot.get(js_string!("mapping"), context).ok())
            .unwrap_or_default();
        JobCallback::new(callback, CapturedContext(mapping))
    }

    /// HostCallJobCallback: runs the reaction with its captured mapping
    /// current and restores the previous one afterwards.
    fn call_job_callback(
        &self,
        job: &JobCallback,
        this: &JsValue,
        args: &[JsValue],
        context: &mut Context,
    ) -> JsResult<JsValue> {
        let Some(slot) = async_context_slot(context) else {
            return job.callback().call(this, args, context);
        };
        let captured = job
            .host_defined()
            .downcast_ref::<CapturedContext>()
            .map(|captured| captured.0.clone())
            .unwrap_or_default();
        let previous = slot.get(js_string!("mapping"), context)?;
        slot.set(js_string!("mapping"), captured, false, context)?;
        let result = job.callback().call(this, args, context);
        slot.set(js_string!("mapping"), previous, false, context)?;
        result
    }

    /// HostPromiseRejectionTracker: hands each rejection without a handler,
    /// and each handler added after one, to the profile's tracking hook.
    fn promise_rejection_tracker(
        &self,
        promise: &JsObject<Promise>,
        operation: OperationType,
        context: &mut Context,
    ) {
        let global = context.global_object();
        let Ok(hook) = global.get(js_string!("__fetchletPromiseRejection"), context) else {
            return;
        };
        let Some(hook) = hook.as_callable() else {
            return;
        };
        let promise = promise.clone().upcast();
        let reason = match JsPromise::from_object(promise.clone()).map(|promise| promise.state()) {
            Ok(PromiseState::Rejected(reason)) => reason,
            _ => JsValue::undefined(),
        };
        let handled = JsValue::from(operation == OperationType::Handle);
        let _ = hook.call(
            &JsValue::undefined(),
            &[promise.into(), reason, handled],
            context,
        );
    }
}

fn host(context: &Context) -> HostBridge {
    context
        .get_data::<BoaHost>()
        .expect("host installed")
        .0
        .clone()
}

fn type_error(message: &str) -> JsError {
    JsNativeError::typ().with_message(message.to_owned()).into()
}

/// `__fetchletTakeBytes(handle)`: a Uint8Array with bytes Rust stored.
fn take_bytes(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let handle = args.get_or_undefined(0).to_number(context)?;
    let bytes = host(context)
        .take_guest_bytes(handle)
        .map_err(|error| type_error(error.guest_message()))?;
    Ok(JsUint8Array::from_iter(bytes.iter().copied(), context)?.into())
}

/// `__fetchletPutBytes(view)`: copy a Uint8Array into the store; returns its handle.
fn put_bytes(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let view = args
        .get_or_undefined(0)
        .as_object()
        .and_then(|object| JsUint8Array::from_object(object.clone()).ok())
        .ok_or_else(|| type_error("expected a Uint8Array"))?;
    let offset = view.byte_offset(context)?;
    let length = view.length(context)?;
    let buffer = view
        .buffer(context)?
        .as_object()
        .and_then(|object| JsArrayBuffer::from_object(object.clone()).ok())
        .ok_or_else(|| type_error("expected an ArrayBuffer-backed Uint8Array"))?;
    let host = host(context);
    let data = buffer
        .data()
        .ok_or_else(|| type_error("detached byte array"))?;
    let bytes = offset
        .checked_add(length)
        .and_then(|end| data.get(offset..end))
        .ok_or_else(|| type_error("byte array is out of bounds"))?;
    let handle = host
        .put_guest_bytes(bytes)
        .map_err(|error| type_error(error.guest_message()))?;
    Ok(JsValue::from(handle as f64))
}

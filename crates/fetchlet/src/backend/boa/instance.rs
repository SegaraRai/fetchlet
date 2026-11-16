use anyhow::{Result, anyhow};
use boa_engine::builtins::promise::PromiseState;
use boa_engine::object::builtins::{JsArrayBuffer, JsUint8Array};
use boa_engine::{
    Context, JsArgs, JsError, JsNativeError, JsResult, JsString, JsValue, NativeFunction, Source,
    js_string,
};
use serde_json::Value;

use super::array_buffer;
use crate::Instance;
use crate::bridge::HostBridge;
use crate::execution::{HOST_BOOTSTRAP, LOOP_STEP, LoopState, PRELUDE, WakeSignal, invocation};

pub struct Boa {
    context: Context,
    poisoned: bool,
    wake: WakeSignal,
}
struct BoaHost(HostBridge);

impl Boa {
    pub fn new(source: &str) -> Result<Self> {
        Self::with_host(source, HostBridge::default())
    }

    pub(crate) fn with_host(source: &str, host: HostBridge) -> Result<Self> {
        let mut context = Context::default();
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
            .eval(Source::from_bytes(&expression))
            .map_err(|error| anyhow!("{error}"))?;
        let promise = result
            .as_promise()
            .ok_or_else(|| anyhow!("Invocation did not return a Promise"))?;
        loop {
            self.context
                .run_jobs()
                .map_err(|error| anyhow!("{error}"))?;
            match promise.state() {
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

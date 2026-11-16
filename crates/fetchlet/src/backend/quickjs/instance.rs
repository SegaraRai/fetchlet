use anyhow::{Result, anyhow};
use bytes::Bytes;
use rquickjs::function::Func;
use rquickjs::{
    Context, Ctx, Error, Exception, IntoJs, Persistent, Promise, Runtime, TypedArray,
    Value as JsValue,
};
use serde_json::Value;

use super::QuickJsOptions;
use crate::Instance;
use crate::bridge::HostBridge;
use crate::execution::{HOST_BOOTSTRAP, LOOP_STEP, LoopState, PRELUDE, WakeSignal, invocation};

pub struct QuickJs {
    context: Context,
    _runtime: Runtime,
    wake: WakeSignal,
    poisoned: bool,
}

impl QuickJs {
    pub fn new(source: &str) -> Result<Self> {
        Self::with_options(source, QuickJsOptions::default())
    }

    pub fn with_options(source: &str, options: QuickJsOptions) -> Result<Self> {
        Self::with_host(source, HostBridge::default(), options)
    }

    pub(crate) fn with_host(
        source: &str,
        host: HostBridge,
        options: QuickJsOptions,
    ) -> Result<Self> {
        options.validate()?;
        let runtime = Runtime::new()?;

        if let Some(limit) = options.memory_limit_bytes {
            runtime.set_memory_limit(limit);
        }
        if let Some(limit) = options.stack_limit_bytes {
            runtime.set_max_stack_size(limit);
        }

        let wake = host.wake_signal();
        let context = Context::full(&runtime)?;
        context.with(|context| -> Result<()> {
            let take = host.clone();
            context.globals().set(
                "__fetchletTakeBytes",
                Func::from(move |ctx: Ctx<'_>, handle: f64| {
                    let bytes = take
                        .take_guest_bytes(handle)
                        .map_err(|error| Exception::throw_type(&ctx, error.guest_message()))?;
                    Ok::<_, Error>(Uint8Bytes(bytes))
                }),
            )?;
            let put = host.clone();
            context.globals().set(
                "__fetchletPutBytes",
                Func::from(move |ctx: Ctx<'_>, view: TypedArray<'_, u8>| {
                    let raw = view
                        .as_raw()
                        .ok_or_else(|| Exception::throw_type(&ctx, "detached byte array"))?;
                    // SAFETY: the view is alive and no JavaScript runs while
                    // its bytes are copied into the store.
                    let bytes = unsafe { raw.as_ref() };
                    put.put_guest_bytes(bytes)
                        .map(|handle| handle as f64)
                        .map_err(|error| Exception::throw_type(&ctx, error.guest_message()))
                }),
            )?;
            context.globals().set(
                "__fetchletHost",
                Func::from(move |operation: String, input: String| host.dispatch(operation, input)),
            )?;
            context.eval::<(), _>(PRELUDE)?;
            context.eval::<(), _>(HOST_BOOTSTRAP)?;
            context.eval::<(), _>(source).map_err(|error| {
                let exception = context.catch();
                anyhow!("{error}: {exception:?}")
            })?;
            Ok(())
        })?;

        Ok(Self {
            context,
            _runtime: runtime,
            wake,
            poisoned: false,
        })
    }
}

impl Instance for QuickJs {
    fn is_reusable(&self) -> bool {
        !self.poisoned
    }

    async fn call_json(&mut self, export: &str, args: &[Value]) -> Result<Value> {
        self.evaluate(invocation(export, args)?).await
    }
}

impl QuickJs {
    /// Evaluate an invocation expression and drive its Promise to completion.
    /// The invocation script owns timer and response-body cleanup.
    pub(crate) async fn evaluate(&mut self, expression: String) -> Result<Value> {
        if self.poisoned {
            anyhow::bail!("Instance cannot be reused after an interrupted call");
        }

        self.poisoned = true;
        let promise = self.context.with(|context| -> Result<_> {
            let promise: Promise = context.eval(expression)?;
            Ok(Persistent::save(&context, promise))
        })?;

        loop {
            let (result, state) = self.context.with(|context| -> Result<_> {
                let promise = promise.clone().restore(&context)?;
                match promise.finish::<String>() {
                    Ok(json) => {
                        self.poisoned = false;
                        Ok((Some(json), None))
                    }
                    Err(Error::WouldBlock) => {
                        let json: String = context.eval(LOOP_STEP)?;
                        let state: LoopState = serde_json::from_str(&json)?;
                        Ok((None, Some(state)))
                    }
                    Err(error) => {
                        let exception = context.catch();
                        self.poisoned = false;
                        Err(anyhow!("{error}: {exception:?}"))
                    }
                }
            })?;

            if let Some(json) = result {
                return Ok(serde_json::from_str(&json)?);
            }

            if let Some(state) = state {
                if state.progress {
                    tokio::task::yield_now().await;
                } else {
                    self.wake.wait(state.timer_delay()).await;
                }
            }
        }
    }
}

/// Bytes returned to JavaScript as a new Uint8Array.
struct Uint8Bytes(Bytes);

impl<'js> IntoJs<'js> for Uint8Bytes {
    fn into_js(self, ctx: &Ctx<'js>) -> rquickjs::Result<JsValue<'js>> {
        TypedArray::<u8>::new_copy(ctx.clone(), &self.0).map(TypedArray::into_value)
    }
}

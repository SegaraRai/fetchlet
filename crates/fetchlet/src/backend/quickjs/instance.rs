use anyhow::{Result, anyhow};
use bytes::Bytes;
use rquickjs::function::Func;
use rquickjs::{
    Context, Ctx, Error, Exception, IntoJs, Persistent, Promise, Runtime, TypedArray,
    Value as JsValue, qjs,
};
use serde_json::Value;

use super::QuickJsOptions;
use crate::Instance;
use crate::backend::{CodeCache, Script, Startup};
use crate::bridge::HostBridge;
use crate::execution::{
    FLUSH_REJECTIONS, HOST_BOOTSTRAP, LOOP_STEP, LoopState, PRELUDE, SEAL_HOST, WakeSignal,
    invocation, observed,
};

pub struct QuickJs {
    context: Context,
    runtime: Runtime,
    wake: WakeSignal,
    poisoned: bool,
}

impl QuickJs {
    pub fn new(source: &str) -> Result<Self> {
        Self::with_options(source, QuickJsOptions::default())
    }

    pub fn with_options(source: &str, options: QuickJsOptions) -> Result<Self> {
        Self::with_host(&Startup::unchecked(source), HostBridge::default(), options)
    }

    pub(crate) fn with_host(
        startup: &Startup<'_>,
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

        runtime.set_host_promise_rejection_tracker(Some(Box::new(track_rejection)));

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
            let cache = startup.code_cache().map(|cache| &**cache);
            evaluate_script(&context, cache, Script::Prelude, PRELUDE)?;
            evaluate_script(&context, cache, Script::Bridge, HOST_BOOTSTRAP)?;
            let report = match startup.check().probe() {
                Some(probe) => Some(context.eval::<String, _>(probe)?),
                None => None,
            };
            startup.check().admit(report.as_deref())?;
            evaluate_script(&context, cache, Script::Module, startup.source()).map_err(
                |error| {
                    let exception = context.catch();
                    anyhow!("{error}: {exception:?}")
                },
            )?;
            context.eval::<(), _>(SEAL_HOST)?;
            Ok(())
        })?;

        Ok(Self {
            context,
            runtime,
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
            let promise: Promise = context.eval(observed(&expression))?;
            Ok(Persistent::save(&context, promise))
        })?;

        loop {
            let step = self.context.with(|context| -> Result<_> {
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
            });
            let (result, state) = match step {
                Ok(step) => step,
                Err(error) => {
                    if !self.poisoned {
                        self.flush_rejections();
                    }
                    return Err(error);
                }
            };

            if let Some(json) = result {
                self.flush_rejections();
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

impl QuickJs {
    /// Notify unhandled rejections once an invocation settles, and run the
    /// jobs their listeners queue.
    fn flush_rejections(&mut self) {
        self.context.with(|context| {
            if context.eval::<(), _>(FLUSH_REJECTIONS).is_err() {
                let _ = context.catch();
            }
        });
        while !matches!(self.runtime.execute_pending_job(), Ok(false)) {}
    }
}

/// The engine name compiled code is cached under.
const ENGINE: &str = "quickjs";

/// Evaluate a global script as `Ctx::eval` does, in strict mode, through the
/// application's bytecode for it when another instance compiled it, or
/// compiling it and keeping its bytecode otherwise.
fn evaluate_script(
    ctx: &Ctx<'_>,
    cache: Option<&CodeCache>,
    script: Script,
    source: &str,
) -> rquickjs::Result<()> {
    let Some(cache) = cache else {
        return ctx.eval::<(), _>(source);
    };
    let raw = ctx.as_raw().as_ptr();
    let function = match cache.get(ENGINE, script) {
        // SAFETY: the bytes are what `JS_WriteObject` wrote for this script
        // in this process, with this QuickJS, so they are well formed.
        Some(code) => unsafe {
            qjs::JS_ReadObject(
                raw,
                code.as_ptr(),
                code.len() as _,
                qjs::JS_READ_OBJ_BYTECODE as i32,
            )
        },
        None => {
            let text = std::ffi::CString::new(source)?;
            // SAFETY: `text` is a NUL-terminated copy of `source`, alive for
            // the call.
            let function = unsafe {
                qjs::JS_Eval(
                    raw,
                    text.as_ptr(),
                    source.len() as _,
                    c"eval_script".as_ptr(),
                    (qjs::JS_EVAL_TYPE_GLOBAL
                        | qjs::JS_EVAL_FLAG_STRICT
                        | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
                )
            };
            if !is_exception(function) {
                keep_bytecode(ctx, cache, script, function);
            }
            function
        }
    };
    if is_exception(function) {
        return Err(Error::Exception);
    }
    // SAFETY: `JS_EvalFunction` takes ownership of the compiled function and
    // returns a new value, which `JsValue` then owns.
    let result = unsafe { qjs::JS_EvalFunction(raw, function) };
    if is_exception(result) {
        return Err(Error::Exception);
    }
    drop(unsafe { JsValue::from_raw(ctx.clone(), result) });
    Ok(())
}

/// Write `function`'s bytecode into the cache. A failed write, such as one
/// past the memory limit, leaves the script uncached.
fn keep_bytecode(ctx: &Ctx<'_>, cache: &CodeCache, script: Script, function: qjs::JSValue) {
    let raw = ctx.as_raw().as_ptr();
    let mut size: qjs::size_t = 0;
    // SAFETY: `function` is a live compiled script; the returned buffer is
    // `size` bytes allocated in this context, freed below.
    unsafe {
        let bytes =
            qjs::JS_WriteObject(raw, &mut size, function, qjs::JS_WRITE_OBJ_BYTECODE as i32);
        if bytes.is_null() {
            qjs::JS_FreeValue(raw, qjs::JS_GetException(raw));
            return;
        }
        cache.put(
            ENGINE,
            script,
            std::slice::from_raw_parts(bytes, size as usize),
        );
        qjs::js_free(raw, bytes.cast());
    }
}

fn is_exception(value: qjs::JSValue) -> bool {
    // SAFETY: reading a value's tag has no other effect.
    unsafe { qjs::JS_VALUE_GET_NORM_TAG(value) == qjs::JS_TAG_EXCEPTION }
}

/// HostPromiseRejectionTracker: hands each rejection without a handler, and
/// each handler added after one, to the profile's tracking hook.
fn track_rejection<'js>(ctx: Ctx<'js>, promise: JsValue<'js>, reason: JsValue<'js>, handled: bool) {
    let Ok(Some(hook)) = ctx
        .globals()
        .get::<_, Option<rquickjs::Function<'js>>>("__fetchletPromiseRejection")
    else {
        return;
    };
    if hook.call::<_, ()>((promise, reason, handled)).is_err() {
        let _ = ctx.catch();
    }
}

/// Bytes returned to JavaScript as a new Uint8Array.
struct Uint8Bytes(Bytes);

impl<'js> IntoJs<'js> for Uint8Bytes {
    fn into_js(self, ctx: &Ctx<'js>) -> rquickjs::Result<JsValue<'js>> {
        TypedArray::<u8>::new_copy(ctx.clone(), &self.0).map(TypedArray::into_value)
    }
}

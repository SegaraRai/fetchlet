use anyhow::{Result, anyhow};
use rquickjs::function::Func;
use rquickjs::{Context, Error, Persistent, Promise, Runtime};
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
        if self.poisoned {
            anyhow::bail!("Instance cannot be reused after an interrupted call");
        }

        let expression = invocation(export, args)?;
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
                        context.eval::<(), _>("globalThis.__fetchletClearTimers?.()")?;
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
                        context.eval::<(), _>("globalThis.__fetchletClearTimers?.()")?;
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

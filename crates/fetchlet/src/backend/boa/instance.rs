use anyhow::{Result, anyhow};
use boa_engine::builtins::promise::PromiseState;
use boa_engine::{Context, JsArgs, JsString, NativeFunction, Source, js_string};
use serde_json::Value;

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

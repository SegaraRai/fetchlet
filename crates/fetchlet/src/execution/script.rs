const INVOKE_EXPORT: &str = include_str!("../../js/invoke.js");

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
const RESPONSE_BODY: &str = include_str!("../../js/response-body.js");

/// Call an exported function. The invocation ends when its Promise settles.
pub(crate) fn invocation(export: &str, args: &[serde_json::Value]) -> anyhow::Result<String> {
    export_invocation(export, args, false)
}

/// Call a Fetch handler that may leave its response body open for streaming.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) fn fetch_invocation(export: &str, args: &[serde_json::Value]) -> anyhow::Result<String> {
    export_invocation(export, args, true)
}

fn export_invocation(
    export: &str,
    args: &[serde_json::Value],
    stream_response_body: bool,
) -> anyhow::Result<String> {
    let export_name = serde_json::to_string(export)?;
    let arguments = serde_json::to_string(args)?;

    Ok(format!(
        "({INVOKE_EXPORT})({export_name}, {arguments}, {stream_response_body})"
    ))
}

/// Pull from or cancel a response body left open by a Fetch invocation.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) fn response_body_operation(operation: ResponseBodyOperation, body: u64) -> String {
    let operation = match operation {
        ResponseBodyOperation::Pull => "pull",
        ResponseBodyOperation::Cancel => "cancel",
    };
    format!("({RESPONSE_BODY})({operation:?}, {body})")
}

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
#[derive(Clone, Copy)]
pub(crate) enum ResponseBodyOperation {
    Pull,
    Cancel,
}

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) const PRELUDE: &str = include_str!("../../js/runtime.js");

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) const HOST_BOOTSTRAP: &str = include_str!("../../js/host-bridge.js");

pub(crate) const LOOP_STEP: &str = include_str!("../../js/event-loop.js");

/// Notify rejections that stayed unhandled through the last microtask
/// checkpoint. Engines run it when an invocation settles; the loop step runs
/// it before each step.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) const FLUSH_REJECTIONS: &str = "globalThis.__fetchletFlushRejections?.()";

/// An invocation expression whose Promise the host observes, so its own
/// rejection, which the host reports as the call's error, is not also an
/// unhandled rejection in JavaScript.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) fn observed(expression: &str) -> String {
    let expression = expression.trim_end().trim_end_matches(';');
    format!(
        "((promise) => {{ promise.then(undefined, () => {{}}); return promise; }})({expression})"
    )
}

/// Settle the background work of the open invocation.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) const BACKGROUND_SETTLE: &str = include_str!("../../js/background.js");

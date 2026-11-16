pub(crate) fn invocation(export: &str, args: &[serde_json::Value]) -> anyhow::Result<String> {
    const INVOKE_EXPORT: &str = include_str!("../../js/invoke.js");

    let export_name = serde_json::to_string(export)?;
    let arguments = serde_json::to_string(args)?;

    Ok(format!("({INVOKE_EXPORT})({export_name}, {arguments})"))
}

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
pub(crate) const PRELUDE: &str = include_str!("../../js/runtime.js");

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
pub(crate) const HOST_BOOTSTRAP: &str = include_str!("../../js/host-bridge.js");

pub(crate) const LOOP_STEP: &str = include_str!("../../js/event-loop.js");

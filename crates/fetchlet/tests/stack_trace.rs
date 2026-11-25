#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Every engine provides V8's stack trace API: `Error.captureStackTrace`
//! with `Error.prepareStackTrace` call sites and `Error.stackTraceLimit`,
//! which libraries such as depd use while they load. QuickJS and Boa get
//! the parts they lack from js-src/stack-trace.ts.

use anyhow::Result;
use serde_json::json;

use fetchlet::Instance;

const SOURCE: &str = include_str!("fixtures/stack-trace.js");

async fn stack_trace_api(mut instance: impl Instance) -> Result<()> {
    assert_eq!(
        instance.call_json("depd", &[]).await?,
        json!({
            "file": "string",
            "line": "number",
            "column": "number",
            "name": "loadingModule",
        })
    );
    assert_eq!(instance.call_json("methods", &[]).await?, json!([]));
    assert_eq!(
        instance.call_json("skipsThroughTheFunction", &[]).await?,
        json!("caller")
    );
    assert_eq!(instance.call_json("limit", &[]).await?, json!(1));
    let formatted = instance.call_json("formatted", &[]).await?;
    let formatted = formatted.as_str().unwrap_or_default();
    assert!(formatted.contains("at formatted ("), "{formatted}");
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn every_engine_provides_the_stack_trace_api() -> Result<()> {
    #[cfg(feature = "quickjs")]
    stack_trace_api(fetchlet::QuickJs::new(SOURCE)?).await?;
    #[cfg(feature = "boa")]
    stack_trace_api(fetchlet::Boa::new(SOURCE)?).await?;
    #[cfg(feature = "v8")]
    stack_trace_api(fetchlet::V8::new(SOURCE)?).await?;
    Ok(())
}

/// Boa formats a captured stack as V8 does, with the target's name and
/// message first; QuickJS lists only the frames.
#[cfg(feature = "boa")]
#[tokio::test(flavor = "current_thread")]
async fn boa_formats_captured_stacks_as_v8_does() -> Result<()> {
    let mut boa = fetchlet::Boa::new(SOURCE)?;
    let formatted = boa.call_json("formatted", &[]).await?;
    let formatted = formatted.as_str().unwrap_or_default();
    assert!(
        formatted.starts_with("Error: described\n    at formatted ("),
        "{formatted}"
    );
    Ok(())
}

#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Engines with an async context slot carry the current mapping through
//! promise reactions, and each invocation starts in the empty context. The
//! expected values are Node's for the same programs with AsyncLocalStorage
//! (docs/research/async-context.md).

use anyhow::Result;
use serde_json::{Value, json};

use fetchlet::Instance;

const SOURCE: &str = include_str!("fixtures/async-context.js");

async fn call(instance: &mut impl Instance, export: &str) -> Result<Value> {
    instance.call_json(export, &[]).await
}

async fn propagates(mut instance: impl Instance) -> Result<()> {
    assert_eq!(call(&mut instance, "hasSlot").await?, json!(true));
    assert_eq!(
        call(&mut instance, "concurrentRuns").await?,
        json!([["a", "a", "a"], ["b", "b", "b"]])
    );
    assert_eq!(
        call(&mut instance, "thenRegistration").await?,
        json!("registered")
    );
    assert_eq!(call(&mut instance, "thenable").await?, json!("awaited"));
    assert_eq!(
        call(&mut instance, "asyncGenerator").await?,
        json!(["first", "second"])
    );
    assert_eq!(
        call(&mut instance, "forAwait").await?,
        json!([[1, "loop"], [2, "loop"]])
    );
    assert_eq!(
        call(&mut instance, "enterWithinRun").await?,
        json!(["entered", null])
    );
    assert_eq!(call(&mut instance, "leaveEntered").await?, json!("leaked"));
    assert_eq!(call(&mut instance, "readEntered").await?, json!(null));
    Ok(())
}

#[cfg(feature = "boa")]
#[tokio::test(flavor = "current_thread")]
async fn boa_propagates_async_context() -> Result<()> {
    propagates(fetchlet::Boa::new(SOURCE)?).await
}

#[cfg(feature = "v8")]
#[tokio::test(flavor = "current_thread")]
async fn v8_propagates_async_context() -> Result<()> {
    propagates(fetchlet::V8::new(SOURCE)?).await
}

/// QuickJS has no slot until quickjs-ng can carry a value through promise
/// jobs (quickjs-ng/quickjs#1919).
#[cfg(feature = "quickjs")]
#[tokio::test(flavor = "current_thread")]
async fn quickjs_has_no_async_context_slot() -> Result<()> {
    let mut instance = fetchlet::QuickJs::new(SOURCE)?;
    assert_eq!(call(&mut instance, "hasSlot").await?, json!(false));
    Ok(())
}

#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Each engine reports promise rejections to `__fetchletPromiseRejection`
//! and calls `__fetchletFlushRejections` once an invocation settles, after
//! its microtasks have run.

use anyhow::Result;
use serde_json::{Value, json};

use fetchlet::Instance;

const SOURCE: &str = include_str!("fixtures/rejections.js");

/// The tracked rejections since the last call, and whether a flush followed
/// the last of them. A flush from the previous call's end may come first.
async fn take_log(instance: &mut impl Instance) -> Result<(Vec<Value>, bool)> {
    let log = instance.call_json("takeLog", &[]).await?;
    let log = log.as_array().cloned().unwrap_or_default();
    let flush = json!(["flush"]);
    let last_track = log.iter().rposition(|entry| *entry != flush);
    let flushed = match last_track {
        Some(index) => log[index + 1..].contains(&flush),
        None => true,
    };
    let tracked = log.into_iter().filter(|entry| *entry != flush).collect();
    Ok((tracked, flushed))
}

async fn rejections(mut instance: impl Instance) -> Result<()> {
    take_log(&mut instance).await?;

    instance.call_json("unhandled", &[]).await?;
    let (tracked, flushed) = take_log(&mut instance).await?;
    assert_eq!(tracked, [json!(["track", "lost", false])]);
    assert!(flushed);

    instance.call_json("handledLater", &[]).await?;
    let (tracked, flushed) = take_log(&mut instance).await?;
    assert_eq!(
        tracked,
        [
            json!(["track", "late", false]),
            json!(["track", "late", true])
        ]
    );
    assert!(flushed);

    // The host reports a failed call's rejection as the call's error, so
    // the invocation's own promise does not stay an unhandled rejection. The
    // export's promise, already rejected when `await` takes it, is reported
    // and then handled within the same checkpoint.
    assert!(instance.call_json("fails", &[]).await.is_err());
    let (tracked, _) = take_log(&mut instance).await?;
    assert!(
        tracked.chunks(2).all(|pair| pair
            == [
                json!(["track", "Error: call", false]),
                json!(["track", "Error: call", true])
            ]),
        "{tracked:?}"
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn every_engine_reports_rejections_to_the_profile() -> Result<()> {
    #[cfg(feature = "quickjs")]
    rejections(fetchlet::QuickJs::new(SOURCE)?).await?;
    #[cfg(feature = "boa")]
    rejections(fetchlet::Boa::new(SOURCE)?).await?;
    #[cfg(feature = "v8")]
    rejections(fetchlet::V8::new(SOURCE)?).await?;
    Ok(())
}

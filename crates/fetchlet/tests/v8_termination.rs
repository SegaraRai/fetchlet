#![cfg(feature = "v8")]

//! With `V8Options::reliable_termination`, the busy timeout stops loops
//! that V8 otherwise runs to the end in code from concurrent on-stack
//! replacement, such as one around `new Array(n).fill(value)`
//! (docs/research/interrupts-and-heap-limits.md#the-v8-termination-gap).
//! The flag is process-wide, so this file is its own test binary and every
//! instance in it sets the option.

use std::time::{Duration, Instant};

use fetchlet::{App, Backend, Error, Limits, Module, V8Options};

const SOURCE: &str = r#"
globalThis.fetchletExports = {
  fill() {
    for (;;) {
      new Array(1000).fill(0);
    }
  },
  passed() {
    const fill = (array) => array.fill(0);
    for (;;) {
      fill(new Array(1000));
    }
  },
};
"#;

const BUSY: Duration = Duration::from_millis(200);

/// A safety net: without the option the loop runs past it, the App drops
/// the call with `DeadlineExceeded` and the assertion below fails.
const DEADLINE: Duration = Duration::from_secs(5);

#[tokio::test]
async fn the_busy_timeout_stops_allocating_loops() -> anyhow::Result<()> {
    for export in ["fill", "passed"] {
        let mut app = App::builder(Backend::V8(V8Options {
            reliable_termination: true,
            ..V8Options::default()
        }))
        .module(Module::new(SOURCE))
        .limits(Limits {
            busy_timeout: Some(BUSY),
            timeout: Some(DEADLINE),
            ..Limits::default()
        })
        .build()?;
        let started = Instant::now();
        let error = app.call_json(export, &[]).await.unwrap_err();
        if !matches!(error, Error::LimitExceeded("engine busy time")) {
            // Dropping the App would join a worker that never stops.
            std::mem::forget(app);
            panic!("{export}: {error:?} after {:?}", started.elapsed());
        }
        assert!(!app.is_reusable(), "{export}");
    }
    Ok(())
}

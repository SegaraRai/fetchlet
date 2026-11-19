#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Guest code reaches the host only through fetchlet's operations, and a
//! guest-chosen size cannot abort the host process.

use serde_json::{Value, json};

use fetchlet::{App, Backend, Module};

const SOURCE: &str = r#"
globalThis.fetchletExports = {
  engineGlobals: () => ({
    deno: typeof globalThis.Deno,
    bootstrap: typeof globalThis.__bootstrap,
  }),
  transfer: (length) => {
    const source = new Uint8Array([1, 2, 3, 4]).buffer;
    let error = null;
    try {
      source.transfer(length);
    } catch (caught) {
      error = caught.name;
    }
    const sourceKept = source.byteLength === 4 && !source.detached;
    const moved = source.transfer(6);
    return {
      error,
      sourceKept,
      moved: Array.from(new Uint8Array(moved)),
      detached: source.detached,
    };
  },
};
"#;

fn app(backend: Backend) -> App {
    App::builder(backend)
        .module(Module::new(SOURCE))
        .fetch_handler(None)
        .build()
        .expect("the probe module builds")
}

fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::boa(),
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

/// deno_core's `Deno.core` holds built-in ops such as `op_panic`, which
/// aborts the process, and `op_print`, which writes to its stdout.
#[tokio::test(flavor = "current_thread")]
async fn engine_internals_are_not_guest_globals() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend);
        let globals: Value = app.call("engineGlobals", &json!(null)).await?;
        assert_eq!(
            globals,
            json!({ "deno": "undefined", "bootstrap": "undefined" })
        );
    }
    Ok(())
}

/// A transfer larger than the engine allows throws a RangeError and keeps
/// the source buffer, as AllocateArrayBuffer precedes the detach.
#[tokio::test(flavor = "current_thread")]
async fn array_buffer_transfer_rejects_impossible_lengths() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend);
        let result: Value = app.call("transfer", &json!(1u64 << 42)).await?;
        assert_eq!(
            result,
            json!({
                "error": "RangeError",
                "sourceKept": true,
                "moved": [1, 2, 3, 4, 0, 0],
                "detached": true,
            })
        );
    }
    Ok(())
}

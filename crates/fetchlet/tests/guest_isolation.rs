#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Guest code reaches the host only through fetchlet's operations, the
//! raw host functions only through the bundle's one-time claim, and a
//! guest-chosen size cannot abort the host process.

use serde_json::{Value, json};

use fetchlet::{App, Backend, Module};

const SOURCE: &str = r#"
const claimed = globalThis.__fetchletClaimHost();
const claimedAgain = typeof globalThis.__fetchletClaimHost;
const hostGlobals = () =>
  ["__fetchletHost", "__fetchletPutBytes", "__fetchletTakeBytes", "__fetchletClaimHost"].map(
    (name) => typeof globalThis[name],
  );
const atLoad = hostGlobals();
globalThis.fetchletExports = {
  host: () => ({
    claimed: Object.keys(claimed).sort(),
    bindings: JSON.parse(claimed.call("bindings", "null")).ok,
    claimedAgain,
    atLoad,
    atCall: hostGlobals(),
  }),
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

/// The host functions leave the global object before the bundle runs; the
/// bundle claims them once while it is evaluated, and code that runs later
/// finds neither them nor the claim.
#[tokio::test(flavor = "current_thread")]
async fn host_functions_are_claimed_once_by_the_bundle() -> anyhow::Result<()> {
    for backend in backends() {
        let mut app = app(backend);
        let host: Value = app.call("host", &json!(null)).await?;
        assert_eq!(
            host,
            json!({
                "claimed": ["call", "putBytes", "readWholeBody", "takeBytes"],
                "bindings": true,
                "claimedAgain": "undefined",
                "atLoad": ["undefined", "undefined", "undefined", "undefined"],
                "atCall": ["undefined", "undefined", "undefined", "undefined"],
            })
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

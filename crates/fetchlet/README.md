# fetchlet

Embed a JavaScript runtime (QuickJS, Boa, or V8) inside Rust to call Fetch
handlers and exported JavaScript functions with explicit permissions and
resource limits.

```sh
cargo add fetchlet
```

## Quick example

```rust
use std::num::NonZeroUsize;
use fetchlet::{App, Backend, Module, WorkerOptions};

let app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .spawn(WorkerOptions::new(NonZeroUsize::new(8).unwrap()))
    .await?;

let sum = app.call_json("add", &[20.into(), 22.into()]).await?;
let response = app.fetch(request).await?;
app.shutdown().await?;
```

For serving a web framework build directory over HTTP or inside a Tauri webview,
use [`fetchlet-http`](https://crates.io/crates/fetchlet-http).

## Cargo features

| Feature             | Adds                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `quickjs` (default) | `Backend::quickjs()`, `Backend::QuickJs(QuickJsOptions)`                                              |
| `boa`               | `Backend::boa()`, `Backend::Boa(BoaOptions)`                                                          |
| `v8`                | `Backend::v8()`, `Backend::V8(V8Options)`                                                             |
| `process`           | [Process isolation](https://fetchlet.roundtrip.dev/docs/rust/fetchlet#process-isolation) per instance |

Multiple engine features can be enabled together. Host Web API implementations
are enabled by default via `web-apis` (`url`, `url-pattern`, `compression`,
`web-crypto`, `node-crypto`).

### V8 on Windows (MSVC)

When enabling `v8` on Windows with MSVC, link against the static C runtime in
`.cargo/config.toml` to match V8's prebuilt library:

```toml
[target.'cfg(all(windows, target_env = "msvc"))']
rustflags = ["-C", "target-feature=+crt-static"]
```

## Documentation

- **Guide:** <https://fetchlet.roundtrip.dev/docs/rust/fetchlet>
- **API reference:** <https://docs.rs/fetchlet>
- **Full documentation:** <https://fetchlet.roundtrip.dev/docs>
- **Coding agents:** installing the `fetchlet` npm package bundles Markdown docs
  and skills in `node_modules/fetchlet/`
  ([guide](https://fetchlet.roundtrip.dev/docs/agents)).

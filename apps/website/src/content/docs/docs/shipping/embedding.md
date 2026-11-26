---
title: "Embedding and distribution"
slug: docs/shipping/embedding
description: "Ship a single Rust binary containing the JS engine, server bundle, and compressed assets — or wrap it in a Tauri desktop app."
---

A fetchlet program can ship as one self-contained executable with no Node.js
runtime and no external asset directory required at runtime.

## What goes into the binary

| Part          | Source                                                               | How it is loaded                                        |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| JS engine     | `fetchlet` crate feature (`quickjs`, `boa`, or `v8`)                 | Linked into the executable                              |
| Server bundle | `server.js` from your adapter or `fetchlet build`                    | `Module::new(source).requires(artifact.requirements())` |
| Manifest      | `fetchlet.json` (handler, exports, backend, requirements, assets)    | `Artifact::handler()`, `Artifact::requirements()`       |
| Client assets | `assets.flpk`, a Brotli [asset archive](/docs/reference/asset-archive) | `AssetArchive`, served by `AssetService`              |

## Embedding an artifact

First, enable `assets: true` in your framework adapter (or `--assets` in
`fetchlet build`) so static files are packed into `build/assets.flpk`.

Then embed the entire artifact directory at compile time with
`fetchlet_http::include_artifact!`, and optionally attach `.dev_directory(...)`
so development builds with `dev-reload` still reload live from disk while
release builds serve the embedded copy — with no `#[cfg]` branches needed:

```rust
use fetchlet_http::{Artifact, Server};

let artifact: Artifact = fetchlet_http::include_artifact!("../build")?;
Server::from_artifact(artifact)
    .dev_directory("build")
    .serve(listener)
    .await?;
```

For custom routers, `Artifact::open("build")` loads the exact same layout from
disk.

## Connecting JavaScript and Rust

- **Rust → JavaScript (HTTP):** Rust passes requests to your framework and
  streams back responses.
- **JavaScript → Rust (in-process):** Server-side JS calls Rust handlers or a
  shared axum router via `fetch()` with no network hop
  ([In-process fetch](/docs/rust/in-process-fetch)), or calls Rust directly via
  [Function bindings](/docs/rust/host-services#function-bindings).
- **Rust → JavaScript (functions):** `AppHandle::call` invokes any named export
  directly — useful for CLI subcommands or Tauri commands.

### Lifecycle

Start `AppHandle` once during application startup, clone it into request
handlers or commands, and call `shutdown().await` before exiting so in-flight
requests and `waitUntil` tasks finish cleanly.

## Desktop apps with Tauri

fetchlet runs your framework's server side in-process while Tauri manages the
native window and webview. Using
[`Server::webview`](/docs/rust/fetchlet-http#serving-a-webviews-uri-scheme),
your app serves pages over a custom URI scheme without binding a local TCP port:

- **Consistent origin:** WebView2 (Windows) and Android load custom schemes from
  `http://<scheme>.localhost/`, while macOS and Linux use
  `<scheme>://localhost/`. Your framework always receives
  `http://<scheme>.localhost` URLs, and Tauri treats the scheme as local so
  pages can use Tauri IPC.
- **One binary, CLI + desktop:** because `Server::serve` and `Server::webview`
  share the same router and host services, one binary can offer both a web
  server subcommand and a desktop window (as in
  [examples/sveltekit-axum-tauri](https://github.com/SegaraRai/fetchlet/tree/main/examples/sveltekit-axum-tauri)).

### Tauri webview limitations

- **Buffered bodies:** Tauri's `UriSchemeResponder` requires a complete response
  body, so streamed responses are collected up to the byte limit passed to
  `Server::webview(scheme, max_body_bytes)`. Request bodies are also collected
  by the webview before reaching Rust.
- **No client IP:** custom URI scheme requests have no TCP peer address.
- **CSP headers:** Tauri's built-in CSP injection applies only to its own asset
  protocol; return a `Content-Security-Policy` header from your app or Rust
  middleware.

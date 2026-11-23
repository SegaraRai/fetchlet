# fetchlet

fetchlet embeds JavaScript functions and Fetch handlers in Rust
applications. Choose QuickJS, Boa or V8; fetchlet supplies the Web APIs and
polyfills that engine needs and connects the JavaScript side to Rust.

The main use is to run the server side of web frameworks — SvelteKit,
Astro, Nuxt, React Router, HonoX and more — inside a Rust program, so a CLI,
local tool, self-hosted service or desktop app ships one binary with a rich
web UI. Rust passes a `Request` and receives the `Response` the JavaScript
produced. Named synchronous and asynchronous functions run on the same
runtime.

```rust
use std::num::NonZeroUsize;
use fetchlet::{App, Backend, Body, Module, WorkerOptions, http};

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let source = std::fs::read_to_string("artifacts/functions-hono.js")?;
    let app = App::builder(Backend::quickjs())
        .module(Module::new(source))
        .spawn(WorkerOptions::new(NonZeroUsize::new(8).unwrap()))
        .await?;

    let request = http::Request::builder()
        .uri("https://fetchlet.invalid/hello/Rust")
        .body(Body::empty())?;

    let response = app.fetch(request).await?;
    let body = response.into_body().collect(1024 * 1024).await?;
    println!("{}", std::str::from_utf8(&body)?);
    app.shutdown().await?;

    Ok(())
}
```

`vp run build:fixtures` builds the bundle this example loads; `vp run
example:embed` runs it. The 1 MiB collection limit and the queue of eight
are budgets the caller chooses. `app.call("transform", &input)` calls a
function with a Serde value and `app.call_json("add", &[...])` with several
JSON arguments.

## Features

- **One runtime, three engines.** The `quickjs` (default), `boa` and `v8`
  Cargo features can be enabled together. The same Web API profile runs on
  each, verified against WPT, Test262 and real framework builds.
- **Shared handles.** `AppHandle` is `Clone + Send + Sync`, owns the
  JavaScript thread and queue, cancels a call when its future is dropped,
  rebuilds an instance after cancellation and drains on shutdown.
- **HTTP integration.** `fetchlet-http` serves an app through Tower and
  `http` 1, with thin layers for hyper, axum and actix-web behind features.
  Request and response bodies stream in both directions. `fetchlet-net`
  provides the HTTP, TCP, TLS and WebSocket transports of JavaScript's
  outbound fetch, sockets and WebSockets.
- **Explicit authority.** `HostServices` grants environment values, named
  Rust services and outbound fetch. `FetchPolicy` allows origins; Rust
  rewrites requests and attaches credentials. JavaScript can call Rust
  routers in-process, with a trusted `Context` it cannot read or forge.
- **Caller budgets.** Every `Limits` field is optional and owned by the
  caller; limits that come from specifications are documented as such.
- **Framework adapters.** The `fetchlet` npm package builds a framework's
  server output into an artifact — `server.js`, `fetchlet.json` and a
  Brotli asset archive — that Rust reads from disk or embeds with
  `include_artifact!`.

## Examples

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum#serve
```

Open `http://127.0.0.1:3000`. Rust runs the HTTP server, and a dedicated
thread runs the SvelteKit server code on QuickJS.

| Example                                                         | Port |
| --------------------------------------------------------------- | ---- |
| [SvelteKit + axum](examples/sveltekit-axum/README.md)           | 3000 |
| [Astro + axum](examples/astro-axum/README.md)                   | 3100 |
| [Nuxt + axum](examples/nuxt-axum/README.md)                     | 3200 |
| [React Router + axum](examples/react-router-axum/README.md)     | 3300 |
| [HonoX + axum](examples/honox-axum/README.md)                   | 3400 |
| [TanStack Start + axum](examples/tanstack-start-axum/README.md) | 3500 |
| [SolidStart + axum](examples/solidstart-axum/README.md)         | 3600 |
| [Qwik City + axum](examples/qwik-city-axum/README.md)           | 3700 |
| [Waku + axum](examples/waku-axum/README.md)                     | 3800 |
| [vinext + axum](examples/vinext-axum/README.md)                 | 3900 |

Each starts with `vp run @fetchlet-internal/example-<name>#serve`. Two more
examples run in Tauri: [HonoX + Tauri](examples/honox-tauri/README.md), and
[Markdown Workspace](examples/sveltekit-axum-tauri/README.md), a note app
whose single binary `mdw` is both a CLI web server and a desktop app, and
whose SvelteKit server code calls the Rust API in-process through types
generated from its OpenAPI document.

## Workspace

```text
crates/fetchlet/       Functions and Fetch, shared handles, host services
crates/fetchlet-http/  Tower, hyper, axum and actix integration; artifacts and asset archives
crates/fetchlet-net/   Outbound HTTP, TCP, TLS and WebSocket transports
packages/fetchlet/     The fetchlet npm package: runtime, artifact builder, framework integrations
packages/web/          @fetchlet/web: the Web API implementations that run in the engine
examples/              Runnable applications per framework and Rust server
fixtures/              Pinned framework builds and probes for the engine matrix
tests/conformance/     Pinned WPT and Test262 sources and expectations
tools/                 Repository tooling, including the fetchlet-lab host
fuzz/                  Fuzzing of the Rust host boundary
docs/                  Documentation
results/               Recorded test results
```

## Documentation

Start with the [overview](docs/overview.md), the [domain
model](docs/domain-model.md) and the [data flow](docs/data-flow.md). The
[documentation index](docs/README.md) lists every guide.

## Development

```bash
vp install --frozen-lockfile
vp run check
vp run test:rust
vp run test:matrix
vp run test:host
```

`vp run verify` runs every regular suite. [Verification](docs/verification.md)
describes each one, and [security](docs/security.md#fuzzing) covers fuzzing.
Dependencies are pinned by `Cargo.lock` and `pnpm-lock.yaml`.

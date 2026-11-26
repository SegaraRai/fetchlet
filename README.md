<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (not (prefers-reduced-motion: reduce))" srcset="assets/brand/logo-horizontal-dark-animated.svg">
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-horizontal-dark.svg" />
    <source media="(prefers-color-scheme: light) and (not (prefers-reduced-motion: reduce))" srcset="assets/brand/logo-horizontal-light-animated.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/logo-horizontal-light.svg" />
    <img alt="fetchlet" src="assets/brand/logo-horizontal-light.svg" width="320" />
  </picture>
</p>

<p align="center">
  <strong>Embed the server side of JavaScript web frameworks inside a Rust binary.</strong>
</p>

<p align="center">
  <a href="https://fetchlet.roundtrip.dev">Website</a> ·
  <a href="https://fetchlet.roundtrip.dev/docs">Getting started</a> ·
  <a href="https://fetchlet.roundtrip.dev/docs/frameworks">Frameworks</a> ·
  <a href="https://fetchlet.roundtrip.dev/docs/agents">Coding agents</a> ·
  <a href="examples/README.md">Examples</a>
</p>

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (not (prefers-reduced-motion: reduce))" srcset="https://svgreel-localize.roundtrip.dev/github/SegaraRai/fetchlet/assets/fetchlet-overview-dark-%7Blang%7D.svg?langs=en%2Cja">
    <source media="(not (prefers-reduced-motion: reduce))" srcset="https://svgreel-localize.roundtrip.dev/github/SegaraRai/fetchlet/assets/fetchlet-overview-light-%7Blang%7D.svg?langs=en%2Cja">
    <source media="(prefers-color-scheme: dark)" srcset="https://svgreel-localize.roundtrip.dev/github/SegaraRai/fetchlet/assets/fetchlet-overview-dark-%7Blang%7D.still.svg?langs=en%2Cja">
    <img src="https://svgreel-localize.roundtrip.dev/github/SegaraRai/fetchlet/assets/fetchlet-overview-light-%7Blang%7D.still.svg?langs=en%2Cja" alt="fetchlet overview" width="100%">
  </picture>
</p>

fetchlet runs the server side of SvelteKit, Astro, TanStack Start, React Router,
Nuxt, Solid, HonoX, and more inside a Rust process — on **QuickJS**, **Boa**, or
**V8**. Ship a CLI, local tool, self-hosted service, or Tauri desktop app as a
single binary with a rich web UI, without bundling Node.js or running a reverse
proxy.

Rust passes a standard `Request` and receives a `Response`, and can also call
exported JavaScript functions directly through the same runtime.

## Quick start

A fetchlet application has two halves: the `fetchlet` npm package bundles your
framework into a portable artifact directory (`build/`), and a Rust host serves
it with `fetchlet` and `fetchlet-http`.

**Prerequisites:** Node.js 20.19, 22.12, 24+ (build time) and Rust 1.100+.

### 1. Build the JavaScript artifact

```sh
npm install --save-dev fetchlet
```

Configure your framework adapter (for example, SvelteKit):

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: fetchletAdapter({
        out: "build",
        assets: true,
      }),
    }),
  ],
});
```

Running `vite build` writes `build/` with `server.js`, `fetchlet.json`, and
client assets (packed into `assets.flpk` when `assets: true`). See
[Frameworks](https://fetchlet.roundtrip.dev/docs/frameworks) for all 12
adapters, or use `fetchlet build` without Vite.

### 2. Serve it from Rust

```sh
cargo add fetchlet
cargo add fetchlet-http --features axum
cargo add tokio --features macros,rt-multi-thread,net
cargo add anyhow
```

```rust
// server/main.rs
use fetchlet::HostServices;
use fetchlet_http::Server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    println!("Listening on http://127.0.0.1:3000");
    Server::new("build")
        .host_services(|| HostServices::new().env("APP_NAME", "fetchlet"))
        .serve(listener)
        .await?;
    Ok(())
}
```

To embed the build directory into a single executable at compile time, use
`fetchlet_http::include_artifact!("../build")`
([Embedding and distribution](https://fetchlet.roundtrip.dev/docs/shipping/embedding)).

### Calling JavaScript without HTTP

Use `fetchlet::App` / `AppHandle` directly to invoke a Fetch handler or call
named JavaScript exports with Serde values (`app.call("transform", &input)` or
`app.call_json("add", &[...])`). See
[Running JavaScript](https://fetchlet.roundtrip.dev/docs/rust/fetchlet).

## Highlights

- **Three engines, one Web API profile.** Choose `quickjs` (default, fast
  startup), `boa` (pure Rust), or `v8` (JIT, native Intl & WebAssembly) via
  Cargo features — all running the same WinterTC Web API layer and Node.js
  compatibility subset.
- **In-process Rust integration.** Expose Rust functions directly on `env`
  (`Functions`), or route internal origins (`https://fetchlet.internal`) to your
  axum router with zero TCP overhead and a trusted `Context` JavaScript cannot
  read or forge.
- **Deny-by-default permissions.** JavaScript has no network, filesystem, or
  host env access unless granted through `HostServices`. Outbound HTTP, TCP, and
  WebSocket clients enforce exact allowlists and block private IPs by default.
- **Resource limits & process isolation.** Configure timeouts, CPU busy limits,
  heap caps, body sizes, and subrequest budgets in Rust. Enable the `process`
  feature to isolate each engine instance in a child process.
- **Single-binary & Tauri ready.** Pack static assets into a Brotli
  `assets.flpk` archive, embed everything with `include_artifact!`, or serve
  over a Tauri custom URI scheme with `Server::webview`.
- **Coding agent friendly.** Installing the `fetchlet` npm package bundles
  version-matched Markdown docs and agent skills in `node_modules/fetchlet/`
  ([Coding agents](https://fetchlet.roundtrip.dev/docs/agents)).

## Examples

Run any example from this repository:

```sh
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum#serve
```

| Example                                                         | Host        | Port |
| --------------------------------------------------------------- | ----------- | ---- |
| [TanStack Start + axum](examples/tanstack-start-axum/README.md) | axum        | 3500 |
| [React Router + axum](examples/react-router-axum/README.md)     | axum        | 3300 |
| [vinext + axum](examples/vinext-axum/README.md)                 | axum        | 3900 |
| [Astro + axum](examples/astro-axum/README.md)                   | axum        | 3100 |
| [SvelteKit + axum](examples/sveltekit-axum/README.md)           | axum        | 3000 |
| [Nuxt + axum](examples/nuxt-axum/README.md)                     | axum        | 3200 |
| [SolidStart + axum](examples/solidstart-axum/README.md)         | axum        | 3600 |
| [Solid 2 + axum](examples/solid-axum/README.md)                 | axum        | —    |
| [Waku + axum](examples/waku-axum/README.md)                     | axum        | 3800 |
| [Qwik City + axum](examples/qwik-city-axum/README.md)           | axum        | 3700 |
| [HonoX + axum](examples/honox-axum/README.md)                   | axum        | 3400 |
| [Vanilla Vite + axum](examples/vanilla-axum/README.md)          | axum        | —    |
| [Vanilla CLI](examples/vanilla-cli/README.md)                   | CLI         | —    |
| [HonoX + Tauri](examples/honox-tauri/README.md)                 | Tauri       | —    |
| [Markdown Workspace](examples/sveltekit-axum-tauri/README.md)   | CLI / Tauri | —    |

See [examples/README.md](examples/README.md) for dev loops (`dev`, `dev:vite`)
and switching engines.

## Documentation

- **User docs:** <https://fetchlet.roundtrip.dev/docs>
- **Rust API reference:** [docs.rs/fetchlet](https://docs.rs/fetchlet) ·
  [fetchlet-http](https://docs.rs/fetchlet-http) ·
  [fetchlet-net](https://docs.rs/fetchlet-net)
- **Maintainer docs:** [docs/README.md](docs/README.md)

## Repository layout

```text
crates/fetchlet/       Core runtime: engines, AppHandle pools, HostServices, process isolation
crates/fetchlet-http/  HTTP integrations (Tower, hyper, axum, actix), Server, artifacts, webviews
crates/fetchlet-net/   Outbound HTTP, TCP/TLS, and WebSocket transports
crates/fetchlet-web/   Engine-independent Rust implementations of Web APIs
packages/fetchlet/     User-facing npm package: framework adapters, CLI, runtime
packages/node/         @fetchlet/node: guest Node.js built-in modules
packages/web/          @fetchlet/web: guest Web API implementations
examples/              Runnable applications per framework and Rust host
apps/website/          Documentation website (fetchlet.roundtrip.dev)
docs/                  Maintainer documentation, research, and TODOs
```

## Contributing & development

```sh
vp install --frozen-lockfile
vp run check
vp run test:rust
vp run test:matrix
vp run test:host
```

`vp run verify` runs the full regular test suite. See
[docs/verification.md](docs/verification.md) and
[docs/security-testing.md](docs/security-testing.md) for details.

## License

Dual-licensed under MIT or Apache-2.0.

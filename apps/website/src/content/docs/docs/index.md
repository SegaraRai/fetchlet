---
title: Getting started
slug: docs
description: Build a SvelteKit application into a fetchlet artifact and serve it from a Rust program with axum.
---

A fetchlet application has two parts:

1. **JavaScript build** — the `fetchlet` npm package bundles your web framework's server code and client assets into an artifact directory (`build/`).
2. **Rust host** — your Rust program loads that directory with `fetchlet` and `fetchlet-http` and serves it over HTTP (or embeds it into a single binary).

This guide walks through SvelteKit and axum. For other frameworks, see [Frameworks](/docs/frameworks). To let a coding agent configure your project automatically, see [Coding agents](/docs/agents).

## Prerequisites

- **Node.js** 20.19, 22.12, 24 or later (for building the JavaScript side)
- **Rust** 1.100 or later

A typical layout keeps the JavaScript app and Rust host side by side in the same project:

```text
my-app/
├── package.json
├── vite.config.ts
├── src/            # SvelteKit app
├── build/          # fetchlet artifact (generated)
├── Cargo.toml
└── server/
    └── main.rs     # Rust host
```

## 1. Build the artifact

In your JavaScript project, install `fetchlet` as a development dependency:

```sh
vp i -D fetchlet
```

Configure the SvelteKit adapter in `vite.config.ts`:

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
      }),
    }),
  ],
});
```

Run your build command (for example, `vite build`). fetchlet writes `build/` containing:

- `server.js` — the bundled server entry
- `fetchlet.json` — manifest describing the handler, target engine, and requirements
- `client/` — static client assets

If you are not using Vite, use the [`fetchlet build` command](/docs/javascript/build#the-fetchlet-build-command) instead.

## 2. Serve it from Rust

Add the required crates to your Rust project. `fetchlet` enables the QuickJS engine by default; add `--features boa` or `--features v8` to use another engine.

```sh
cargo add fetchlet
cargo add fetchlet-http --features axum
cargo add tokio --features macros,rt-multi-thread,net
cargo add anyhow
```

Start a server that reads the `build/` directory:

```rust
// server/main.rs
use fetchlet_http::Server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    println!("Listening on http://127.0.0.1:3000");
    Server::new("build").serve(listener).await?;
    Ok(())
}
```

Run `cargo run` and open `http://127.0.0.1:3000`. `Server` serves client assets directly from Rust and forwards every other request to your framework.

You can also add Rust API routes, pass environment values and host services to JavaScript, and set resource limits on `Server` ([Serving over HTTP](/docs/rust/fetchlet-http#serving-a-build-with-server)).

## 3. Develop with live reload

During development, `fetchlet dev` watches your JavaScript sources, rebuilds the artifact on changes, and keeps the Rust server running with automatic browser reload.

Add a `dev` feature in `Cargo.toml` that enables `fetchlet-http/dev-reload`, then run:

```sh
vp exec fetchlet dev -- cargo run --features dev
```

Frameworks with Vite Environment API support can also run directly against `vite dev` without rebuilding ([Development server](/docs/javascript/dev)).

## 4. Ship as a single binary

When you are ready to distribute your app, pack static assets into `assets.flpk` (`assets: true` in the adapter) and embed the build directory with `fetchlet_http::include_artifact!`. See [Embedding and distribution](/docs/shipping/embedding).

## Calling JavaScript without HTTP

You do not need an HTTP server to use fetchlet. `fetchlet::App` lets Rust invoke a Fetch handler directly or call any exported JavaScript function with Serde values (`app.call("transform", &input)`). See [Running JavaScript](/docs/rust/fetchlet).

## Next steps

- [Overview & choosing an engine](/docs/overview#choosing-an-engine): decide between QuickJS, Boa, and V8.
- [Frameworks](/docs/frameworks): adapter setup and request context for each framework.
- [Development server](/docs/javascript/dev): choose the best dev loop for your framework.
- [Host services](/docs/rust/host-services): pass environment values, Rust functions, and outbound fetch to JavaScript.
- [Examples](https://github.com/SegaraRai/fetchlet/tree/main/examples): runnable projects for every supported framework.

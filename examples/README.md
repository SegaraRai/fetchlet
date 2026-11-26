# Examples

Runnable end-to-end applications for every supported framework and Rust host
(axum, Tauri, and CLI).

## Running an example

From the repository root:

```sh
vp install --frozen-lockfile

# Build and serve an example (default: QuickJS)
vp run @fetchlet-internal/example-sveltekit-axum#serve

# Run a live-reloading dev loop (rebuilds on change)
vp run @fetchlet-internal/example-sveltekit-axum#dev

# Run against Vite dev with HMR (supported frameworks)
vp run @fetchlet-internal/example-tanstack-start-axum#dev:vite
```

## Available examples

| Example                                          | Host        | Highlights                                                                                                           |
| ------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| [TanStack Start + axum](tanstack-start-axum)     | axum        | Streaming SSR, server functions, server routes, `dev:vite`, WebSocket, Rust service                                  |
| [React Router + axum](react-router-axum)         | axum        | Streaming SSR, actions, resource routes, prerendered pages, `dev:vite`, WebSocket                                    |
| [vinext + axum](vinext-axum)                     | axum        | Next.js App Router on Vite, RSC, SSR, route handlers, WebSocket                                                      |
| [Astro + axum](astro-axum)                       | axum        | SSR, Svelte island, FormatJS Intl, streaming uploads, `dev:vite`, WebSocket                                          |
| [SvelteKit + axum](sveltekit-axum)               | axum        | SSR, actions, endpoints, in-process Rust API (`OriginRouter`), WebSocket                                             |
| [Nuxt + axum](nuxt-axum)                         | axum        | SSR, server routes, runtime config, `defineWebSocketHandler`, Rust service                                           |
| [SolidStart + axum](solidstart-axum)             | axum        | Streaming SSR, server functions, API routes, `dev:vite`, WebSocket                                                   |
| [Solid 2 + axum](solid-axum)                     | axum        | Solid 2 without SolidStart, streaming SSR, server functions, `dev:vite`, WebSocket                                   |
| [Waku + axum](waku-axum)                         | axum        | RSC, SSR, API routes, WebSocket, Rust service                                                                        |
| [Qwik City + axum](qwik-city-axum)               | axum        | Resumability, `routeLoader$`, endpoints, WebSocket, Rust service                                                     |
| [HonoX + axum](honox-axum)                       | axum        | Islands, API routes, `fetchlet/hono/websocket`, Rust service                                                         |
| [Vanilla Vite + axum](vanilla-axum)              | axum        | Framework-free Vite server module, streaming HTML, named exports, `dev:vite`, channels                               |
| [Vanilla CLI](vanilla-cli)                       | CLI         | Functions-only artifact without HTTP, called from Rust with bindings and Web Crypto                                  |
| [HonoX + Tauri](honox-tauri)                     | Tauri       | Custom URI scheme without an HTTP server, calling JS exports from Tauri commands                                     |
| [SvelteKit + axum / Tauri](sveltekit-axum-tauri) | CLI / Tauri | Single-binary Markdown workspace (`mdw`), CLI HTTP + Tauri desktop, OpenAPI-typed Rust API, async SSR, file watching |

## Switching engines

Every example defaults to QuickJS. Override `FETCHLET_BACKEND` (`quickjs`,
`boa`, or `v8`) at build time and enable the matching Cargo feature on the Rust
host:

```sh
FETCHLET_BACKEND=v8 vp run --filter @fetchlet-internal/example-honox-axum build
node tools/workspace/cargo.ts run --release -p example-honox-axum --features v8
```

## Verification & benchmarks

- `vp run test:examples` runs the full browser/webview/CLI checks across all
  examples on QuickJS (`-- --backends boa,v8,quickjs` tests all three engines).
- `tools/examples/common-checks.ts` defines the shared end-to-end checks
  (SSR, assets, hydration, navigation, Rust services, WebSockets).
- [tools/bench](../tools/bench/README.md) benchmarks requests per second across
  examples and engines.

---
title: "Nuxt and Nitro"
slug: docs/frameworks/nitro
description: "Build Nuxt and Nitro 2 applications into a fetchlet artifact with the fetchlet/nitro preset."
---

The `fetchlet/nitro` preset bundles Nitro 2 (with h3 1) and Nuxt applications
into a fetchlet artifact. See
[examples/nuxt-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/nuxt-axum)
for a complete setup.

## Setup

```ts
// nuxt.config.ts
/// <reference types="fetchlet/nitro/types" />

export default defineNuxtConfig({
  nitro: {
    preset: "fetchlet/nitro",
    fetchlet: { backend: "quickjs" },
  },
});
```

For standalone Nitro, put the same `preset` and `fetchlet` options in
`nitro.config.ts`. `fetchlet.backend`, `fetchlet.intl`, and
`fetchlet.requirements` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills).

## Output

The preset writes `build/server.js`, `build/client/` (Nitro's public assets),
and `build/fetchlet.json` (with `serveStatic` disabled because Rust serves
static files).

Node.js built-ins implemented by fetchlet (`node:crypto`, `node:async_hooks`,
etc.) and `Buffer`/`process`/`setImmediate`/`clearImmediate` resolve to
fetchlet's runtime ([Node.js compatibility](/docs/compatibility/node)); `unenv`
handles the remaining modules. The preset enables `asyncContext: "serialized"`.

Set `nitro.fetchlet.assets: true` to pack public assets into `assets.flpk`,
preserving `maxAge` caching headers for entries such as `/_nuxt/`
([Asset archive](/docs/reference/asset-archive)).

## Requests and context

- **Bindings:** read Rust bindings from `event.context.fetchlet.env` and declare
  their types on [`fetchlet/bindings`](/docs/javascript/runtime#binding-types):

  ```ts
  import type { ServiceBinding } from "fetchlet/bindings";

  declare module "fetchlet/bindings" {
    interface FetchletBindings {
      NUXT_MESSAGE: string;
      RUST: ServiceBinding;
    }
  }
  ```

- **Runtime config:** Nitro reads runtime config overrides (keys starting with
  `NUXT_`) from `process.env`. Expose those keys explicitly in Rust with
  `HostServices::process_env("NUXT_...", value)` so they are available on both
  `event.context.fetchlet.env` and `process.env`.
- **Client IP & `waitUntil`:** `getRequestIP(event)` reads
  `event.context.clientAddress`, and `event.waitUntil(promise)` registers
  background work with Rust.
- **Streaming request bodies:** use `getRequestWebStream(event)` to stream
  uploads (`readBody` collects the body).
- **Internal fetches:** `event.$fetch` and `event.fetch` with a relative path
  stay inside Nitro and keep `event.context.fetchlet`. Global `$fetch` with a
  path also stays inside Nitro without the request context. Absolute URLs go
  through Rust's `FetchPolicy`
  ([Framework fetches](/docs/rust/in-process-fetch#framework-fetches)).

## WebSockets

Enable `nitro.experimental.websocket: true` to use `defineWebSocketHandler`.
Configure `Instances::max_held_connections` on your Rust host
([WebSocket upgrades](/docs/rust/fetchlet-http#websocket-upgrades)).

## Notes

- Vue rendering uses `renderToString`, so HTML responses are buffered.
- Nitro 3 (h3 2), streaming SSR, and scheduled tasks are not yet supported.

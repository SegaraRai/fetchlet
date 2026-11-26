---
title: "SolidStart"
slug: docs/frameworks/solid-start
description: "Build a SolidStart 2 server into a fetchlet artifact."
---

The `fetchlet/solid-start` Vite plugin bundles a `@solidjs/start` 2 server
(Solid 1) into a fetchlet artifact without Nitro. For Solid 2 applications, use
[fetchlet/solid](/docs/frameworks/solid). See
[examples/solidstart-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/solidstart-axum)
for a complete setup.

## Setup

```ts
// vite.config.ts
import { solidStart } from "@solidjs/start/config";
import fetchletSolidStart from "fetchlet/solid-start";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solidStart(),
    fetchletSolidStart({ backend: "quickjs" }),
  ],
});
```

`backend`, `intl`, `requirements`, `outDir`, and `assets` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills).

## Output and assets

`vite build` writes `build/server.js`, `build/fetchlet.json`, and
`build/client/`. Pass `assets: true` to pack client assets into `assets.flpk`
with 1-year immutable caching on `_build/assets/`
([Asset archive](/docs/reference/asset-archive)).

## Request context

`getRequestEvent().clientAddress`, h3's `getRequestIP(event)`, and
`event.waitUntil` work as usual. Read Rust bindings with `getRequestContext()`
(typed via [`fetchlet/bindings`](/docs/javascript/runtime#binding-types)):

```ts
import { getRequestContext } from "fetchlet/solid-start/context";

// Use getRequestContext(event) inside API route handlers
const { clientAddress, env, waitUntil } = getRequestContext();
```

- The plugin enables `asyncContext: "serialized"` for `node:async_hooks`.
- Because SolidStart compiles each HTTP method handler of an API route (`GET`,
  `POST`, etc.) as a separate module, place shared state in a separate module.
- Use `fetchWithEvent(event.nativeEvent, "/api/...")` from
  `@solidjs/start/http` for in-framework requests that preserve request
  context; absolute URLs through global `fetch()` go through Rust's
  `FetchPolicy` ([Framework fetches](/docs/rust/in-process-fetch#framework-fetches)).

## Development serving

With `fetchletSolidStart()` configured, run
[`fetchlet dev --vite "vite dev"`](/docs/javascript/dev#serving-from-vite) to
run SolidStart's server entry on your Rust engine while Vite serves browser
modules with Solid HMR (or use `--build-watch "vite build --watch"`).

---
title: "Solid"
slug: docs/frameworks/solid
description: "Build a Solid 2 full-stack application into a fetchlet artifact."
---

The `fetchlet/solid` Vite plugin bundles a Solid 2 full-stack application
(`@solidjs/vite-plugin` with `start` and `ssr: true`) into a fetchlet artifact.
For Solid 1 with SolidStart, use
[fetchlet/solid-start](/docs/frameworks/solid-start). See
[examples/solid-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/solid-axum)
for a complete setup.

## Setup

```ts
// vite.config.ts
import solid from "@solidjs/vite-plugin";
import fetchletSolid from "fetchlet/solid";
import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solid({
      start: {
        middleware: "./src/middleware.ts",
      },
      ssr: true,
    }),
    fileRoutes({
      httpMethods: true,
    }),
    fetchletSolid({
      backend: "quickjs",
      assets: true,
    }),
  ],
});
```

`outDir`, `backend`, `intl`, `requirements`, and `assets` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills).
Solid's `nodeServer` option is not needed.

## Output and assets

`vite build` writes `build/server.js`, `build/fetchlet.json`, and
`build/client/`. Pass `assets: true` to pack client assets into `assets.flpk`
with 1-year immutable caching on `assets/`
([Asset archive](/docs/reference/asset-archive)).

## Request context

Read the Rust request context with `getRequestContext()` in middleware, API
routes, and server functions (or `getRequestContext(event)` for an explicit
event):

```ts
import { getRequestContext } from "fetchlet/solid/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

Type `env` by declaring your keys on
[`fetchlet/bindings`](/docs/javascript/runtime#binding-types):

```ts
declare module "fetchlet/bindings" {
  interface FetchletBindings {
    MESSAGE: string;
  }
}
```

The plugin enables `asyncContext: "serialized"` for Solid's `AsyncLocalStorage`
request event tracking.

## Development serving

With `fetchletSolid()` configured, run
[`fetchlet dev --vite "vite dev"`](/docs/javascript/dev#serving-from-vite) to
run Solid's SSR handler on your Rust engine while Vite serves browser modules
with Solid HMR (or use `--build-watch "vite build --watch"`).

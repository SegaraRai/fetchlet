---
title: "SvelteKit"
slug: docs/frameworks/sveltekit
description: "Build a SvelteKit server into a fetchlet artifact with the fetchlet/sveltekit adapter."
---

The `fetchlet/sveltekit` adapter bundles a SvelteKit 3 server into a fetchlet
artifact (`build/server.js`, `build/client/`, and `build/fetchlet.json`).
See the
[sveltekit-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/sveltekit-axum)
and
[sveltekit-axum-tauri](https://github.com/SegaraRai/fetchlet/tree/main/examples/sveltekit-axum-tauri)
examples for complete setups.

## Setup

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        experimental: {
          async: false,
        },
      },
      adapter: fetchletAdapter({
        out: "build",
        backend: "quickjs",
      }),
    }),
  ],
});
```

`backend`, `intl`, and `requirements` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills). Build
with `vite build` and develop with [`fetchlet dev`](/docs/javascript/dev) (full
rebuild mode).

## Request context and bindings

| From Rust               | In SvelteKit                  |
| ----------------------- | ----------------------------- |
| Context `clientAddress` | `getClientAddress()`          |
| Host bindings           | `platform.env`                |
| `waitUntil`             | `platform.context.waitUntil`  |
| String env bindings     | `env` passed to `server.init` |

Type `platform.env` by declaring your keys on
[`fetchlet/bindings`](/docs/javascript/runtime#binding-types).

## Assets

Pass `assets: true` to pack `client/` into `build/assets.flpk`:

- Files under `_app/immutable/` receive a 1-year `Cache-Control: immutable`
  header.
- Prerendered pages are served without `.html` or a trailing slash, matching
  SvelteKit's default `trailingSlash: "never"`.
- Customize rules with `assets: { include, routes, cache, respond, entries }`
  ([Asset archive](/docs/reference/asset-archive)).

## Rendering profiles

| `rendering`               | Use                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `"synchronous"` (default) | Standard synchronous Svelte rendering (no `node:async_hooks` needed); promises returned from `load` still stream      |
| `"async"`                 | Svelte's async rendering (`compilerOptions.experimental.async`) and remote functions (`experimental.remoteFunctions`) |

```ts
sveltekit({
  compilerOptions: {
    experimental: {
      async: true,
    },
  },
  experimental: {
    remoteFunctions: true,
  },
  adapter: fetchletAdapter({
    rendering: "async",
  }),
});
```

`"async"` enables `asyncContext: "serialized"` so `getRequestEvent()` works
across `await` within a request. In a remote function, call `getRequestEvent()`
before the first `await` if multiple remote functions run concurrently during
one render.

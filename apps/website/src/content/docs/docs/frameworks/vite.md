---
title: "Vite"
slug: docs/frameworks/vite
description: "Build a framework-free Vite server entry and browser assets into a fetchlet artifact."
---

The `fetchlet/vite` plugin builds a standard Workers-style server module
(`export default { fetch(request, env, ctx) }`) and optional browser entries
into a fetchlet artifact — no framework required. See
[examples/vanilla-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/vanilla-axum)
(and
[examples/vanilla-cli](https://github.com/SegaraRai/fetchlet/tree/main/examples/vanilla-cli)
for a functions-only CLI) for complete setups.

## Setup

```ts
// vite.config.ts
import fetchlet from "fetchlet/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    fetchlet({
      server: "src/server.ts",
      client: "src/client.ts",
      backend: "quickjs",
      assets: true,
    }),
  ],
});
```

| Option         | Default           | Meaning                                                                                   |
| -------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `server`       | `"src/server.ts"` | Server module path                                                                        |
| `client`       | none              | Browser entry points (falls back to `index.html` if present)                              |
| `outDir`       | `"build"`         | Output artifact directory                                                                 |
| `backend`      | `"portable"`      | Target engine (`quickjs`, `boa`, `v8`, or `portable`)                                     |
| `intl`         | `{}`              | `Intl` locales and time zone data ([build options](/docs/javascript/build))               |
| `requirements` | `[]`              | Extra APIs beyond the Web API profile ([build options](/docs/javascript/build))           |
| `assets`       | `false`           | Pack `client/` into `assets.flpk` with 1-year immutable caching on `build.assetsDir`      |

## Writing the server module

Export a default `{ fetch(request, env, ctx) }` handler and any named functions
you want Rust to call via `App::call` / `AppHandle::call_json` (`handle` is
reserved). Modules without a default export build a functions-only artifact.

```ts
import type { ExportedHandler } from "fetchlet/runtime";

declare module "fetchlet/bindings" {
  interface FetchletBindings {
    MESSAGE: string;
  }
}

export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(audit(request.url));
    return new Response(`${env.MESSAGE} from ${ctx.clientAddress}`);
  },
} satisfies ExportedHandler;

export function greet(name: string): string {
  return `Hello, ${name}`;
}
```

`ctx` matches Cloudflare Workers' `ExecutionContext` plus `ctx.clientAddress`
from Rust (`passThroughOnException()` is a no-op). `node:async_hooks` is not
enabled by default; use [`fetchlet/build`](/docs/javascript/build) directly if
you need `asyncContext`.

## Referencing browser entries

Import `virtual:fetchlet/client-assets` in your server module to get the built
`<script>` and `<link rel="stylesheet">` URLs for each client entry:

```ts
/// <reference types="fetchlet/vite/client-assets" />
import clientAssets from "virtual:fetchlet/client-assets";

const { script, styles } = clientAssets["src/client.ts"]!;
```

## Development serving

Run [`fetchlet dev --vite "vite dev"`](/docs/javascript/dev#serving-from-vite)
with `fetchlet-http`'s `vite-dev` feature to run your server module directly on
your Rust engine while Vite serves browser modules with HMR:

- Server edits reload automatically before the next request (and refresh open
  pages); adding a new named export for `App::call` requires restarting the dev
  server.
- `virtual:fetchlet/client-assets` resolves to Vite's HMR client and module
  entries automatically.
- Fetches to Vite's dev origin are routed through the internal dev binding
  without changing your app's `FetchPolicy`.

You can also use `fetchlet dev --build-watch "vite build --watch"` for
sub-second rebuilds.

## Without Vite

If you have no browser bundles to build with Vite, use the
[`fetchlet build` CLI](/docs/javascript/build#the-fetchlet-build-command) or
`exportedHandler` from [`fetchlet/build`](/docs/javascript/build#a-server-module-without-a-framework).

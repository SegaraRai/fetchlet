---
title: "vinext"
slug: docs/frameworks/vinext
description: "Build a vinext (Next.js App Router on Vite) application into a fetchlet artifact."
---

The `fetchlet/vinext` Vite plugin bundles the App Router server of
[vinext](https://github.com/cloudflare/vinext) 1 into a fetchlet artifact. See
[examples/vinext-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/vinext-axum)
for a complete setup.

## Setup

```ts
// vite.config.ts
import fetchletVinext from "fetchlet/vinext";
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vinext(),
    fetchletVinext({
      backend: "quickjs",
    }),
  ],
});
```

`backend`, `intl`, `requirements`, `outDir`, and `assets` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills).

## Output and assets

`vite build` writes `build/server.js`, `build/fetchlet.json`, and
`build/client/`. Pass `assets: true` to pack client assets into `assets.flpk`
with 1-year immutable caching on `_next/static/`
([Asset archive](/docs/reference/asset-archive)).

## Request context

Read the Rust request context in server components, route handlers, and server
actions:

```ts
import { getRequestContext } from "fetchlet/vinext/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

`after()` from `next/server` is wired to `waitUntil` automatically.

## Node APIs

Standard Node built-ins (`node:buffer`, `node:crypto`, etc.) come from
[Node.js compatibility](/docs/compatibility/node). For vinext's additional
expectations, the plugin provides:

| Module or value | Behavior in fetchlet                                       |
| --------------- | ---------------------------------------------------------- |
| `node:path`     | `pathe` (POSIX and win32)                                  |
| `node:fs`       | Empty virtual filesystem (vinext uses its in-memory cache) |
| `node:module`   | `createRequire` for React SSR entries                      |
| `process.env`   | Empty object; `process.platform` is `"linux"`              |

Next.js's fetch cache wraps `globalThis.fetch`; underlying requests still pass
through Rust's `FetchPolicy`.

## Recommended Rust limits

On the first request, vinext registers a `waitUntil` task per route module
preload. If you set `Limits::background_tasks` on your Rust host, give it
headroom (for example, `64`) so initial page renders do not hit the limit.

## Notes

- Pages Router, filesystem ISR persistence, `next/image` optimization, and
  middleware are not currently verified.
- Standard Next.js (`next build`) output is not supported.

---
title: "Waku"
slug: docs/frameworks/waku
description: "Build a Waku RSC server into a fetchlet artifact."
---

The `fetchlet/waku` server entry adapter bundles a Waku 1 (1.0.0-rc.5+) RSC
server into a fetchlet artifact. See
[examples/waku-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/waku-axum)
for a complete setup.

## Setup

```tsx
// src/waku.server.tsx
import adapter from "fetchlet/waku";
import { fsRouter } from "waku";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("/src/pages/**/*.{tsx,ts}")).map(([key, load]) => [
    key.slice("/src/".length),
    load,
  ]),
);

export default adapter(fsRouter(modules), { backend: "quickjs" });
```

`backend`, `intl`, `requirements`, `outDir`, and `assets` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills).
`middlewareFns` and `middlewareModules` work as in other Waku adapters. Build
with `waku build`.

## Output and assets

`waku build` writes `build/server.js`, `build/fetchlet.json`, and
`build/client/` (including statically generated pages). Pass `assets: true` to
pack client assets into `assets.flpk` with 1-year immutable caching on
`assets/` ([Asset archive](/docs/reference/asset-archive)).

## Request context and bindings

Read the Rust request context in server components, server functions, and API
routes (call `getRequestContext()` with no arguments):

```ts
import { getRequestContext } from "fetchlet/waku/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

- In Hono middleware, bindings are available on `c.env` and `waitUntil` on
  `c.executionCtx.waitUntil`.
- String bindings are also accessible via Waku's `getEnv(name)`.
- The adapter enables `asyncContext: "serialized"` for `node:async_hooks`.
- Request body limits are enforced by your Rust host's `Limits::request_body_bytes`
  (Hono's `bodyLimit` middleware is not used).

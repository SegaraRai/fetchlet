---
title: "Hono and HonoX"
slug: docs/frameworks/hono
description: "Build Hono and HonoX applications into fetchlet artifacts."
---

The `fetchlet/hono/vite` plugin wraps `@hono/vite-build` 1 to bundle Hono and
HonoX apps into a fetchlet artifact. See
[examples/honox-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/honox-axum)
and
[examples/honox-tauri](https://github.com/SegaraRai/fetchlet/tree/main/examples/honox-tauri)
for complete setups.

## Setup

```ts
// vite.config.ts
import honox from "honox/vite";
import fetchletBuild from "fetchlet/hono/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [honox(), fetchletBuild({ entry: "./app/server.ts", backend: "quickjs" })],
});
```

- `entry` points to a module with `export default app`.
- `backend`, `intl`, and `requirements` follow the
  [build options](/docs/javascript/build#choosing-a-backend-and-polyfills).
- `external` is forwarded to `@hono/vite-build`.
- `functions` lists extra modules whose named exports become callable from Rust
  via `App::call` / `AppHandle::call` (`handle` is reserved) — useful for Tauri
  commands or CLI helpers.

## Request context and bindings

| Value                      | Content                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `c.env`                    | Rust's fixed bindings                                                    |
| `c.executionCtx.waitUntil` | Registers work after the response, within Rust's background budget       |
| `getConnInfo(c)`           | From `fetchlet/hono/conninfo`: client IP from the Rust request context   |
| `getRequestContext(c)`     | From `fetchlet/hono/conninfo`: the full Rust request context             |

HonoX uses `AsyncLocalStorage` internally; the plugin enables
`asyncContext: "serialized"` automatically.

## WebSockets

Use `upgradeWebSocket` from `fetchlet/hono/websocket` to handle WebSocket
routes. Configure `Instances::max_held_connections` on your Rust host
([WebSocket upgrades](/docs/rust/fetchlet-http#websocket-upgrades)):

```ts
import { upgradeWebSocket } from "fetchlet/hono/websocket";

app.get(
  "/socket",
  upgradeWebSocket(() => ({
    onMessage(event, ws) {
      ws.send(`echo: ${String(event.data)}`);
    },
  })),
);
```

## Output and assets

The plugin writes `build/server.js`, `build/fetchlet.json`, and (with HonoX)
`build/client/`. Pass `assets` to pack static files into `assets.flpk`. Because
Hono public files are not necessarily content-hashed, configure caching
explicitly via `assets: { cache: [...] }`
([Asset archive](/docs/reference/asset-archive)).

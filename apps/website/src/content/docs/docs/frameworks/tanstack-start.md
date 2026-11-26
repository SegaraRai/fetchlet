---
title: "TanStack Start"
slug: docs/frameworks/tanstack-start
description: "Build a TanStack Start server into a fetchlet artifact."
---

The `fetchlet/tanstack-start` Vite plugin bundles a `@tanstack/react-start` 1
server into a fetchlet artifact. See
[examples/tanstack-start-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/tanstack-start-axum)
for a complete setup.

## Setup

```ts
// vite.config.ts
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import fetchletStart from "fetchlet/tanstack-start";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackStart(),
    react(),
    fetchletStart({
      backend: "quickjs",
    }),
  ],
});
```

`backend`, `intl`, and `requirements` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills). The
plugin resolves `react-dom/server` to `react-dom/server.edge` and bundles
dependencies with
[fetchlet's export conditions](/docs/javascript/build#export-conditions).

## Output and assets

`vite build` writes `build/server.js`, `build/fetchlet.json`, and
`build/client/`. Pass `assets: true` to pack `build/client/` into
`assets.flpk` with 1-year immutable caching on `assets/`
([Asset archive](/docs/reference/asset-archive)).

## Request context

Server functions, server routes, and middleware receive a
`FetchletRequestContext`:

| Value           | Content                                                            |
| --------------- | ------------------------------------------------------------------ |
| `clientAddress` | Client IP from the Rust request context                            |
| `env`           | Rust's fixed bindings                                              |
| `waitUntil`     | Registers work after the response, within Rust's background budget |

Register the type once in your app:

```ts
import type { FetchletRequestContext } from "fetchlet/tanstack-start";

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: FetchletRequestContext;
    };
  }
}
```

## Development serving

With `fetchletStart()` configured, run
[`fetchlet dev --vite "vite dev"`](/docs/javascript/dev#serving-from-vite) to
execute Start's server entry on your Rust engine while Vite serves browser
modules with React Fast Refresh (or use `--build-watch "vite build --watch"`).
The first dev request takes a few seconds while Vite pre-bundles server
dependencies.

## Notes

Prerendering, SPA mode, and TanStack Start for Solid are not currently
verified.

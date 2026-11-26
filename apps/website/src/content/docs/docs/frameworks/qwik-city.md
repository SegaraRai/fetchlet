---
title: "Qwik City"
slug: docs/frameworks/qwik-city
description: "Build a Qwik City server into a fetchlet artifact."
---

The `fetchlet/qwik-city/vite` plugin and `fetchlet/qwik-city/middleware`
bundle a `@builder.io/qwik-city` 1 SSR app into a fetchlet artifact. See
[examples/qwik-city-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/qwik-city-axum)
for a complete setup.

## Setup

Add the plugin to `vite.config.ts`:

```ts
// vite.config.ts
import { qwikCity } from "@builder.io/qwik-city/vite";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { fetchletAdapter } from "fetchlet/qwik-city/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    qwikCity(),
    qwikVite({
      client: { outDir: "build/client" },
      ssr: { outDir: "node_modules/.cache/fetchlet-qwik-city" },
    }),
    fetchletAdapter({ backend: "quickjs" }),
  ],
});
```

Create the fetchlet server entry:

```ts
// src/entry.fetchlet.tsx
import qwikCityPlan from "@qwik-city-plan";
import { manifest } from "@qwik-client-manifest";
import { createQwikCity } from "fetchlet/qwik-city/middleware";

import render from "./entry.ssr";

export default createQwikCity({ render, qwikCityPlan, manifest });
```

Build both client and SSR bundles:

```sh
vite build && vite build --ssr
```

The plugin accepts `entry` (default `src/entry.fetchlet.tsx`), `outDir`,
`backend`, `intl`, `requirements`, and `assets`
([build options](/docs/javascript/build#choosing-a-backend-and-polyfills)).

## Request event and bindings

| Value                | Content                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `platform.env`       | Rust's fixed bindings                                              |
| `platform.waitUntil` | Registers work after the response, within Rust's background budget |
| `clientConn.ip`      | Client IP from the Rust request context                            |
| `env.get(name)`      | Reads a string env binding from Rust                               |

Note that Qwik City's built-in CSRF check requires an `Origin` header on
`POST` and other mutating requests.

## Assets and WebSockets

- Pass `assets: true` to pack `build/client/` into `assets.flpk` with 1-year
  immutable caching on `build/` and `assets/`
  ([Asset archive](/docs/reference/asset-archive)).
- To accept WebSockets in an endpoint, call `upgradeWebSocket(request)` from
  `fetchlet/runtime/handler` and pass the returned response to `send(response)`.

## Notes

Qwik 2 (`@qwik.dev/router`) is not supported yet.

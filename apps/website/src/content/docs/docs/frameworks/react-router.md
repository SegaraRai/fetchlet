---
title: "React Router"
slug: docs/frameworks/react-router
description: "Build a React Router framework-mode server into a fetchlet artifact."
---

The `fetchlet/react-router` preset bundles a React Router 8 framework-mode
server into a fetchlet artifact. See
[examples/react-router-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/react-router-axum)
for a complete setup.

## Setup

```ts
// react-router.config.ts
import type { Config } from "@react-router/dev/config";
import { fetchletPreset } from "fetchlet/react-router";

export default {
  presets: [fetchletPreset({ backend: "quickjs" })],
} satisfies Config;
```

`backend`, `intl`, and `requirements` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills). The
preset requires `ssr: true` and a single server bundle (`ssr: false` and
`serverBundles` are not supported). Avoid defining your own `buildEnd` hook in
`react-router.config.ts`, as it overrides the preset's artifact step.

## Output and assets

`vite build` writes `build/server.js`, `build/fetchlet.json`, and
`build/client/`. Pass `assets: true` to pack `build/client/` into
`assets.flpk` with 1-year immutable caching on `assets/`
([Asset archive](/docs/reference/asset-archive)). Pages listed in `prerender`
are served directly from the archive (with or without a trailing slash).

## Load context

In loaders, actions, and middleware, read the fetchlet context with
`getLoadContext(context)` (typed with your
[`fetchlet/bindings`](/docs/javascript/runtime#binding-types) declaration):

```ts
import { getLoadContext } from "fetchlet/react-router/context";

export async function loader({ context }: Route.LoaderArgs) {
  const { clientAddress, env, waitUntil } = getLoadContext(context);
  // ...
}
```

| Value           | Content                                                            |
| --------------- | ------------------------------------------------------------------ |
| `clientAddress` | Client IP from the Rust request context                            |
| `env`           | Rust's fixed bindings                                              |
| `waitUntil`     | Registers work after the response, within Rust's background budget |

## Streaming and stack size

Using `renderToReadableStream` from `react-dom/server.edge` in `entry.server`
streams deferred data directly to the Rust HTTP response.

React's streaming renderer needs more stack space than QuickJS's 1 MiB default
in Rust debug builds. `fetchlet_http::Server` automatically sets a 4 MiB QuickJS
stack limit and a 64 MiB native worker stack; if you build an `App` manually
without `Server`, configure at least a 2–4 MiB QuickJS stack limit.

## Development serving

Add `fetchletDevServer` to `vite.config.ts` to run React Router directly from
`vite dev` behind your Rust host with React Fast Refresh
([`fetchlet dev --vite "vite dev"`](/docs/javascript/dev#serving-from-vite)):

```ts
// vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import { fetchletDevServer } from "fetchlet/react-router";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter(), fetchletDevServer({ backend: "quickjs" })],
});
```

## Notes

Split `serverBundles` and RSC mode are not currently supported.

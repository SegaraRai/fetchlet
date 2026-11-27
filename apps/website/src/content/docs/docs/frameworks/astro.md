---
title: "Astro"
slug: docs/frameworks/astro
description: "Build an Astro server into a fetchlet artifact with the fetchlet/astro adapter."
---

The `fetchlet/astro` adapter builds an Astro 7 server application into a
fetchlet artifact. See
[examples/astro-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/astro-axum)
for a complete setup.

## Setup

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import fetchletAdapter from "fetchlet/astro";

export default defineConfig({
  output: "server",
  adapter: fetchletAdapter({
    backend: "quickjs",
    intl: {
      locales: ["en", "ja"],
      timeZoneData: "golden",
    },
  }),
});
```

`backend`, `intl`, and `requirements` follow the
[build options](/docs/javascript/build#choosing-a-backend-and-polyfills). The
adapter automatically adds `Intl.DateTimeFormat` to `requirements` (bundled via
FormatJS on QuickJS/Boa, native on V8).

## Request context and bindings

| Value                    | Content                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `Astro.locals.env`       | Rust's fixed bindings                                              |
| `Astro.locals.waitUntil` | Registers work after the response, within Rust's background budget |
| `Astro.clientAddress`    | Client IP from the Rust request context                            |
| `getSecret(name)`        | Reads a string env binding from Rust                               |

## Assets

Pass `assets: true` to pack client assets into `assets.flpk`. Files under
`build.assets` (`_astro/` by default) are cached for a year, and page paths
follow your `trailingSlash` and `build.format` settings
([Asset archive](/docs/reference/asset-archive)).

## Development serving

Set `devServer: true` to run `astro dev` behind your Rust host with
`fetchlet-http`'s `vite-dev` feature and
[`fetchlet dev --vite "astro dev"`](/docs/javascript/dev#serving-from-vite):

```js
export default defineConfig({
  output: "server",
  adapter: fetchletAdapter({
    backend: "quickjs",
    devServer: true,
  }),
});
```

Your Rust host executes Astro's server code on your configured engine with full
`Astro.locals` and `getSecret` support, while Vite serves browser modules,
styles, and island HMR. When using a custom host (instead of `Server`), set
`WorkerOptions::cancelled_calls` to `CancelledCalls::Finish` so cancelled
client-router navigations do not reload the module graph.

## Notes

Image transformation, server islands, sessions, and `output: "static"` are not
currently supported by this adapter.

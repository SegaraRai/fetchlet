# fetchlet/qwik-city

A Vite plugin and middleware that bundle a Qwik City 1 SSR build into a
fetchlet artifact. Verified with `@builder.io/qwik` and
`@builder.io/qwik-city` 1.20.4.

```ts
// vite.config.ts
import { fetchletAdapter } from "fetchlet/qwik-city/vite";

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

```ts
// src/entry.fetchlet.tsx
import { createQwikCity } from "fetchlet/qwik-city/middleware";
import qwikCityPlan from "@qwik-city-plan";
import { manifest } from "@qwik-client-manifest";
import render from "./entry.ssr";

export default createQwikCity({ render, qwikCityPlan, manifest });
```

The build has two steps: `vp build && vp build --ssr`. The plugin takes
`entry` (default `src/entry.fetchlet.tsx`), `outDir`, `backend` and `intl`.

## Output

The SSR build bundles `entry` and `@qwik-city-plan` and writes
`build/server.js` and `build/fetchlet.json`. In the client build, the chunk
names Qwik derives from module paths are renamed to names Rolldown accepts
(file names are hashes only).

`assets: true` packs the client assets into `assets.flpk` and caches
`build/` and `assets/` for a year
([asset archive](../../../docs/asset-archive.md)).

## Request event

| Value                | Content                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `platform.env`       | Rust's fixed bindings                                              |
| `platform.waitUntil` | Registers work after the response, within Rust's background budget |
| `clientConn.ip`      | The client address of the request context                          |
| `env.get(name)`      | A string binding                                                   |

The app's request budget limits the body. Rust serves static files, and a
path that reaches Qwik City without matching a route is a 404. Qwik City's
CSRF check requires `Origin` on POST and similar requests.

Qwik 2 (`@qwik.dev/router`) is not supported yet.

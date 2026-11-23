# fetchlet/solid

A Vite plugin that bundles the server of a Solid 2 application into a
fetchlet artifact. Solid 2 builds full-stack applications with
`@solidjs/vite-plugin` in server mode (`start` with `ssr: true`), which
replaces SolidStart for Solid 2; use [fetchlet/solid-start](solid-start.md)
for SolidStart with Solid 1.
[examples/solid-axum](../../../examples/solid-axum/README.md) checks it;
[reference](../../../docs/reference/README.md#examples) records the versions.

```ts
// vite.config.ts
import solid from "@solidjs/vite-plugin";
import fetchletSolid from "fetchlet/solid";
import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solid({
      start: {
        middleware: "./src/middleware.ts",
      },
      ssr: true,
    }),
    fileRoutes({
      httpMethods: true,
    }),
    fetchletSolid({
      backend: "quickjs",
      assets: true,
    }),
  ],
});
```

`outDir`, `backend`, `intl`, `requirements` and `assets` mean the same as in
[fetchlet/vite](vite.md). Solid's `nodeServer` option is not needed.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Output

The client builds to `build/client/` and the server to
`node_modules/.cache/fetchlet-solid/`. The plugin then writes
`build/server.js`, which passes every request to Solid's `handleRequest`,
and `build/fetchlet.json`. Middleware, API routes, server functions and
page rendering run as they do on Solid's own Node server.

The SSR environment bundles every dependency. The `solid` condition compiles
Solid libraries from source for SSR, and `worker` selects Web-standard
builds of other dependencies.

`assets: true` packs the client assets into `assets.flpk` and caches
`assets/` for a year ([asset archive](../../../docs/asset-archive.md)).

## Request context

The entry puts the fetchlet request context on Solid's request event. Read
it with `getRequestContext()` in middleware, API routes and server
functions:

```ts
import { getRequestContext } from "fetchlet/solid/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

`getRequestContext(event)` reads a given request event instead of the
current one. The bindings declared on
[`fetchlet/bindings`](runtime.md#binding-types) type `env`:

```ts
declare module "fetchlet/bindings" {
  interface FetchletBindings {
    MESSAGE: string;
  }
}
```

Solid's server runtime keeps the request event in `AsyncLocalStorage`, so
the plugin enables the builder's `asyncContext: "serialized"`. The same
[concurrency limitation](../../../docs/TODO.md#framework-runtime-needs-beyond-wintertc)
as the other adapters applies.

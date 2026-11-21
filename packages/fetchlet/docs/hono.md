# fetchlet/hono

A Vite plugin that bundles a Hono or HonoX app into a fetchlet artifact. It
builds the app with `@hono/vite-build` and then runs [`fetchlet/build`](build.md).
Supports `@hono/vite-build` 1;
[examples/honox-axum](../../../examples/honox-axum/README.md) and
[examples/honox-tauri](../../../examples/honox-tauri/README.md) check it, and
[reference](../../../docs/reference/README.md#examples) records the versions.

```ts
// vite.config.ts
import fetchletBuild from "fetchlet/hono/vite";

export default defineConfig(({ mode }) => ({
  plugins: [honox(), fetchletBuild({ entry: "./app/server.ts", backend: "quickjs" })],
}));
```

`entry` is a module that does `export default app`. `backend` and `intl`
are the builder's settings, and `external` is passed to `@hono/vite-build`.
The named exports of the modules listed in `functions` become functions that
Rust calls with `App::call` or `AppHandle::call`, next to the Fetch handler
(`handle` is reserved). [HonoX + Tauri](../../../examples/honox-tauri/README.md)
uses them.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Output

The plugin writes `build/server.js` and `build/fetchlet.json`. Rust serves
public files, so `staticPaths` is empty. With HonoX, the client build goes
to `build/client`.

`assets` packs the client assets into `assets.flpk`. Hono's public files are
not necessarily hashed, so there is no default caching rule; set it with
`assets: { cache }` (examples/honox-axum caches `/static/` for a year). See
[asset archive](../../../docs/asset-archive.md).

## Values from Rust

| Value                      | Content                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `c.env`                    | Rust's fixed bindings                                                    |
| `c.executionCtx.waitUntil` | Registers work after the response, within Rust's background budget       |
| `getConnInfo(c)`           | From `fetchlet/hono/conninfo`: the client address of the request context |
| `getRequestContext(c)`     | From `fetchlet/hono/conninfo`: the request context                       |

HonoX keeps its context in `AsyncLocalStorage` from `node:async_hooks`. The
builder's `asyncContext: "serialized"` replaces it with an implementation
that keeps the store for one invocation.

HonoX's client manifest is written to `build/client/.vite/manifest.json`
and can be fetched through Rust's static serving; it maps asset file names
to modules and contains nothing else.

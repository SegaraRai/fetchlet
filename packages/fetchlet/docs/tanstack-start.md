# fetchlet/tanstack-start

A Vite plugin that bundles TanStack Start's server environment into a
fetchlet artifact. Supports `@tanstack/react-start` 1;
[examples/tanstack-start-axum](../../../examples/tanstack-start-axum/README.md) checks it; [reference](../../../docs/reference/README.md#examples) records the versions.

```ts
// vite.config.ts
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import fetchletStart from "fetchlet/tanstack-start";

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

`backend`, `intl` and `requirements` are the [builder's](build.md)
settings.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Output

The client builds to `build/client/` and the server to
`node_modules/.cache/fetchlet-tanstack-start/`; the plugin then writes
`build/server.js`, connected to the server's `fetch`, and
`build/fetchlet.json`.

The SSR environment bundles every dependency with
[fetchlet's export conditions](build.md#export-conditions), whose `worker`
selects router-core's server build.
`react-dom/server` resolves to `react-dom/server.edge` (the worker build
uses `MessageChannel`). `process.env.TSS_PRERENDERING` and `TSS_SHELL`,
which Start reads while evaluating modules, are replaced with `"false"`.

`assets: true` packs the client assets into `assets.flpk` and caches
`assets/` for a year ([asset archive](../../../docs/asset-archive.md)).

## Request context

The `context` of server functions, server routes and middleware is a
`FetchletRequestContext`:

| Value           | Content                                                            |
| --------------- | ------------------------------------------------------------------ |
| `clientAddress` | The client address of the request context                          |
| `env`           | Rust's fixed bindings                                              |
| `waitUntil`     | Registers work after the response, within Rust's background budget |

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

`vite dev` with this plugin serves a Rust host that uses fetchlet-http's
`ViteDev`, as [fetchlet/vite](vite.md#development-serving) does: the host
runs Start's server entry on its engine through Vite's module runner, with
the same request context as the artifact, and Vite serves the browser
modules with React Fast Refresh.

- The plugin marks the `ssr` environment fetchable, so Start leaves requests
  to the host instead of rendering them in Node.
- Server dependencies resolve with the `development` condition in place of
  `production`. Vite prebundles their CommonJS modules, such as React and
  `react-dom/server.edge`, and leaves out the Start packages the browser
  build also leaves out, whose virtual modules Start's plugins provide.
- Node built-ins come from the development artifact's own implementations,
  and `process.env.NODE_ENV` is `"development"`.
- The first request makes Vite optimize the server's dependencies; it takes
  a few seconds, and the runner loads the modules again after Vite reloads
  the environment.

[examples/tanstack-start-axum](../../../examples/tanstack-start-axum/README.md#develop-from-vite)
has a `dev:vite` task.

## Tests and next work

[examples/tanstack-start-axum](../../../examples/tanstack-start-axum/README.md)
runs the shared example checks. Prerendering, SPA mode and TanStack Start
for Solid need their own tests.

# fetchlet/tanstack-start

A Vite plugin that bundles TanStack Start's server environment into a
fetchlet artifact. Verified with `@tanstack/react-start` 1.169.5,
`@tanstack/react-router` 1.170.46 and React 19.3.1.

```ts
// vite.config.ts
import fetchletStart from "fetchlet/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  plugins: [tanstackStart(), react(), fetchletStart({ backend: "quickjs" })],
});
```

`backend` and `intl` are the [builder's](build.md) settings.

## Output

The client builds to `build/client/` and the server to
`node_modules/.cache/fetchlet-tanstack-start/`; the plugin then writes
`build/server.js`, connected to the server's `fetch`, and
`build/fetchlet.json`.

The SSR environment bundles every dependency with the `worker` and
`edge-light` conditions, so router-core uses its server build.
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
    server: { requestContext: FetchletRequestContext<Bindings> };
  }
}
```

## Tests and next work

[examples/tanstack-start-axum](../../../examples/tanstack-start-axum/README.md)
runs the shared example checks. Prerendering, SPA mode and TanStack Start
for Solid need their own tests.

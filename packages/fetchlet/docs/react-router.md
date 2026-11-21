# fetchlet/react-router

A React Router preset that bundles a framework-mode server build into a
fetchlet artifact. Supports React Router 8;
[examples/react-router-axum](../../../examples/react-router-axum/README.md) checks it; [reference](../../../docs/reference/README.md#examples) records the versions.

```ts
// react-router.config.ts
import type { Config } from "@react-router/dev/config";
import { fetchletPreset } from "fetchlet/react-router";

export default {
  presets: [fetchletPreset({ backend: "quickjs" })],
} satisfies Config;
```

`backend` and `intl` are the [builder's](build.md) settings. The preset
requires `ssr: true` and one server bundle; `serverBundles` or `ssr: false`
fails the build.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Output

In React Router's `buildEnd`, the preset connects the server build in
`build/server/` to `createRequestHandler` and writes `build/server.js` and
`build/fetchlet.json`. `build/client/` holds React Router's client assets.
`build/server/` is intermediate output that Rust does not serve. Defining
`buildEnd` in the app's config replaces the preset's artifact step.

`assets: true` packs the client assets into `assets.flpk` and caches
`assets/` for a year ([asset archive](../../../docs/asset-archive.md)).

## Load context

The `context` of loaders, actions and middleware is a
`RouterContextProvider`. fetchlet's values are a `FetchletLoadContext`, read
with `context.get(fetchletContext)` or, typed with the bindings declared on
[`fetchlet/bindings`](runtime.md#binding-types), `getLoadContext(context)`.

| Value           | Content                                                            |
| --------------- | ------------------------------------------------------------------ |
| `clientAddress` | The client address of the request context                          |
| `env`           | Rust's fixed bindings                                              |
| `waitUntil`     | Registers work after the response, within Rust's background budget |

```ts
import { getLoadContext } from "fetchlet/react-router/context";

export async function loader({ context }: Route.LoaderArgs) {
  const { env, waitUntil } = getLoadContext(context);
  // ...
}
```

Vite may bundle this module into the server build separately from the
entry; every copy shares one key through the global symbol registry.

## Rendering and the QuickJS stack

With `renderToReadableStream` from `react-dom/server.edge` in
`entry.server`, deferred data streams in the same response, and the body
reaches Rust's HTTP response as a stream.

React's Fizz catches stack overflows and retries rendering the element. A
`<link` fragment written before the retry stays in the head, producing
broken HTML with status 200. With QuickJS's default 1 MiB stack limit this
happens even for small pages in Rust debug builds, not in release builds
(`/about` in examples/react-router-axum; 2 MiB is enough). fetchlet-http's
`Server` sets `QuickJsOptions::stack_limit_bytes` to 4 MiB and the worker
thread stack to 8 MiB by default, which the example uses; a host that starts
its `App` itself sets them, and the example's end-to-end checks assert that
no fragment remains.

## Development serving

`fetchletDevServer`, added to `vite.config.ts` beside `reactRouter()`,
serves a Rust host that uses fetchlet-http's `ViteDev`, as
[fetchlet/vite](vite.md#development-serving) does:

```ts
import { reactRouter } from "@react-router/dev/vite";
import { fetchletDevServer } from "fetchlet/react-router";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    reactRouter(),
    fetchletDevServer({
      backend: "quickjs",
    }),
  ],
});
```

The host runs React Router's development server build on its engine
through Vite's module runner, with the same load context as the preset's
artifact, and Vite serves the browser modules with React Fast Refresh and
`/@react-router/critical.css`. React Router renders in Node whenever its
`ssr` environment is runnable, so the plugin replaces it with a plain
`DevEnvironment` that the engine's runner fetches from.
[examples/react-router-axum](../../../examples/react-router-axum/README.md#develop-from-vite)
has a `dev:vite` task.

## Tests and next work

[examples/react-router-axum](../../../examples/react-router-axum/README.md)
checks SSR, assets, streaming of deferred data, resource routes, document
and client actions, cookies, the load context, streaming uploads,
`waitUntil`, hydration and client navigation.

Split server bundles, prerendering and RSC mode need their own tests.

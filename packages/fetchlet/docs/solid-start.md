# fetchlet/solid-start

A Vite plugin that bundles SolidStart 2's server environment into a
fetchlet artifact. Supports `@solidjs/start` 2, which runs on Solid 1;
Solid 2 applications build without SolidStart and use
[fetchlet/solid](solid.md).
[examples/solidstart-axum](../../../examples/solidstart-axum/README.md) checks it; [reference](../../../docs/reference/README.md#examples) records the versions.

```ts
import { solidStart } from "@solidjs/start/config";
// vite.config.ts
import fetchletSolidStart from "fetchlet/solid-start";

export default defineConfig({
  plugins: [
    solidStart(),
    fetchletSolidStart({
      backend: "quickjs",
    }),
  ],
});
```

`backend`, `intl` and `requirements` are the [builder's](build.md) settings. Nitro is not
used.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Output

The client builds to `build/client/` and the server to
`node_modules/.cache/fetchlet-solid-start/`; the plugin then writes
`build/server.js`, connected to the h3 app of `entry-server`, and
`build/fetchlet.json`.

The SSR environment bundles every dependency. The `solid` condition compiles
Solid libraries from source for SSR, and `worker` selects solid-js's server
build. h3 keeps its runtime-neutral build.

`assets: true` packs the client assets into `assets.flpk` and caches
`_build/assets/` for a year ([asset archive](../../../docs/asset-archive.md)).

## Request context

The entry sets the `ip`, `waitUntil` and `runtime` that h3 reads from the
request, so `getRequestEvent().clientAddress`, h3's `getRequestIP(event)`
and `event.waitUntil` work as usual. Bindings come from
`getRequestContext()`:

```ts
import { getRequestContext } from "fetchlet/solid-start/context";

const { clientAddress, env, waitUntil } = getRequestContext(); // getRequestContext(event) in API routes
```

The bindings declared on [`fetchlet/bindings`](runtime.md#binding-types) type `env`.
SolidStart and solid-js use `node:async_hooks`, so the plugin enables the
builder's `asyncContext: "serialized"`.

SolidStart builds each method handler of an API route (GET, POST, …) as its
own module; keep state shared between handlers in a separate module.

`fetchWithEvent(event.nativeEvent, "/api/…")` from `@solidjs/start/http`
runs another route in JavaScript with the request's context; an absolute
URL through `fetch` is a host fetch
([framework fetches](../../../docs/in-process-fetch.md#framework-fetches)).

## Development serving

`vite dev` with this plugin serves a Rust host that uses fetchlet-http's
`ViteDev`, as [fetchlet/vite](vite.md#development-serving) does: the host
runs SolidStart's server entry on its engine through Vite's module runner,
with the same request context as the artifact, and Vite serves the browser
modules with Solid's hot module replacement. The plugin marks the `ssr`
environment fetchable, so SolidStart leaves requests to the host instead of
rendering them in Node. The plugin returns an array of plugins.
[examples/solidstart-axum](../../../examples/solidstart-axum/README.md#develop-from-vite)
has a `dev:vite` task.

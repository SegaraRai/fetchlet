# fetchlet/astro

An Astro adapter. It connects Request and Response through Astro's official
server entrypoint API and builds the artifact with
[`fetchlet/build`](build.md). Supports Astro 7 server output;
[examples/astro-axum](../../../examples/astro-axum/README.md) checks it; [reference](../../../docs/reference/README.md#examples) records the versions.

```js
import { defineConfig } from "astro/config";
import fetchletAdapter from "fetchlet/astro";

export default defineConfig({
  output: "server",
  adapter: fetchletAdapter({
    backend: "quickjs",
    intl: { locales: ["en", "ja"], timeZoneData: "golden" },
  }),
});
```

| Value                    | Content                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `Astro.locals.env`       | Rust's fixed bindings                                              |
| `Astro.locals.waitUntil` | Registers work after the response, within Rust's background budget |
| `Astro.clientAddress`    | The client address from the per-request context                    |
| `getSecret(name)`        | A fixed string binding                                             |

Astro's `Intl.DateTimeFormat` requirement is passed to the builder. For
`quickjs` and `boa` it adds FormatJS with its dependencies and the selected
locale and time zone data; for `v8` it uses native Intl. The default
`portable` builds a bundle that works on any engine. Matching the build
backend to the Rust backend keeps native APIs and shrinks the bundle.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Assets

`assets: true` packs the client assets into `assets.flpk`, caches
`build.assets` (`_astro` by default) for a year, and maps page paths
according to `trailingSlash` and `build.format`
([asset archive](../../../docs/asset-archive.md)).

## Development serving

`devServer: true` makes `astro dev` serve a Rust host that uses
fetchlet-http's `ViteDev`, as [fetchlet/vite](vite.md#development-serving)
does:

```js
export default defineConfig({
  output: "server",
  adapter: fetchletAdapter({
    backend: "quickjs",
    devServer: true,
  }),
});
```

The host runs Astro's development app on its engine through Vite's module
runner, with the same `Astro.locals`, client address and `getSecret` as the
artifact, and Vite serves the browser modules, styles and island HMR.
Astro renders in Node whenever its `ssr` environment is runnable, so the
adapter replaces it with a plain `DevEnvironment` that the engine's runner
fetches from. Astro reloads open pages after an edit to a page or a server
module.
[examples/astro-axum](../../../examples/astro-axum/README.md#develop-from-vite)
has a `dev:vite` task.

A request the client cancels, as Astro's client router does when it
navigates, retires the engine instance; the next request evaluates every
module from Vite again, which takes seconds on QuickJS and about 40 seconds
on a debug build of Boa.

## Tests

examples/astro-axum runs on QuickJS with FormatJS and checks SSR, a Svelte
island, forms, cookies, endpoints, streamed rendering, streaming uploads and
client navigation.

Image transformation, server islands, sessions and static output need their
own capabilities and tests.

The adapter uses the [adapter API](https://docs.astro.build/en/reference/adapter-reference/)
and the [server entrypoint API](https://docs.astro.build/en/reference/modules/astro-app/).

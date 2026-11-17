# fetchlet/astro

An Astro adapter. It connects Request and Response through Astro's official
server entrypoint API and builds the artifact with
[`fetchlet/build`](build.md). Verified with Astro 7.4.12 server output.

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

## Assets

`assets: true` packs the client assets into `assets.flpk`, caches
`build.assets` (`_astro` by default) for a year, and maps page paths
according to `trailingSlash` and `build.format`
([asset archive](../../../docs/asset-archive.md)).

## Tests

examples/astro-axum runs on QuickJS with FormatJS and checks SSR, a Svelte
island, forms, cookies, endpoints, streaming uploads and client navigation.

Image transformation, server islands, sessions and static output need their
own capabilities and tests.

The adapter uses the [adapter API](https://docs.astro.build/en/reference/adapter-reference/)
and the [server entrypoint API](https://docs.astro.build/en/reference/modules/astro-app/).

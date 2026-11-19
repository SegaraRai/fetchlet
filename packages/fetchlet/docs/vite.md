# fetchlet/vite

A Vite plugin for applications without a framework: a server module in the
Workers module shape, and optional browser entries. `vite build` builds the
browser entries into `build/client/`, then the server module into
`build/server.js` and `build/fetchlet.json`.
[examples/vanilla-axum](../../../examples/vanilla-axum/README.md) checks it;
[reference](../../../docs/reference/README.md#examples) records the versions.

```ts
// vite.config.ts
import fetchlet from "fetchlet/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    fetchlet({
      server: "src/server.ts",
      client: "src/client.ts",
      backend: "quickjs",
      assets: true,
    }),
  ],
});
```

| Option    | Default           | Meaning                                                                                  |
| --------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `server`  | `"src/server.ts"` | The server module                                                                        |
| `client`  | none              | Browser entries; without them, `index.html` is the client entry when the project has one |
| `outDir`  | `"build"`         | The artifact directory                                                                   |
| `backend` | `"portable"`      | The engine the artifact targets, as in [fetchlet/build](build.md)                        |
| `intl`    | `{}`              | Intl data for engines without native Intl, as in [fetchlet/build](build.md)              |
| `assets`  | `false`           | Pack `client/` into `assets.flpk`; see below                                             |

## The server module

The default export handles requests with `fetch(request, env, ctx)`, as a
Cloudflare Workers module does. `env` holds the host bindings, and `ctx`
has `waitUntil` and the client address. Named exports are functions that
Rust calls with `App::call` or `AppHandle::call_json`, beside the Fetch
handler. The export name `handle` is reserved for the handler the plugin
generates.

```ts
import type { ExportedHandler } from "fetchlet/runtime";

interface Bindings {
  MESSAGE: string;
}

export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(audit(request.url));
    return new Response(`${env.MESSAGE} from ${ctx.clientAddress}`);
  },
} satisfies ExportedHandler<Bindings>;

export function greet(name: string): string {
  return `Hello, ${name}`;
}
```

`ctx` has the shape of Workers' `ExecutionContext`: `passThroughOnException()`
does nothing and `props` is empty, since fetchlet has no origin to fall back
to. `ctx.clientAddress` is fetchlet's addition, from the Rust request
context. The SSR environment resolves dependencies with the `worker`
condition and bundles every one of them; fetchlet/build then bundles the
output again for the engine. `node:async_hooks` is not provided; build with
[fetchlet/build](build.md) directly to choose `asyncContext`.

## Browser entries

The server reads the built URLs of each browser entry from
`virtual:fetchlet/client-assets`, keyed by the entry's path relative to the
Vite root. Each entry has its `script` and the `styles` it imports,
including those of the chunks it imports statically.

```ts
/// <reference types="fetchlet/vite/client-assets" />
import clientAssets from "virtual:fetchlet/client-assets";

const { script, styles } = clientAssets["src/client.ts"]!;
```

The plugin turns on Vite's client manifest to produce this module. The
asset archive leaves `.vite/` out, so the manifest is not served. Without
browser entries and without `index.html`, the client build is skipped and
the artifact has no client assets.

`assets: true` packs the client assets into `assets.flpk` and caches the
hashed files under Vite's `build.assetsDir` (`assets/` by default) for a
year ([asset archive](../../../docs/asset-archive.md)).

## Without Vite

`exportedHandler` from [fetchlet/build](build.md#a-server-module-without-a-framework)
builds the same server module shape without Vite and without browser
entries.

`vite dev` serves the browser entries but does not run the server module;
[development serving](../../../docs/TODO.md#vanilla-javascript) is open work.

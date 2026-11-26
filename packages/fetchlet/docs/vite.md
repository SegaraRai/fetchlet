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

| Option         | Default           | Meaning                                                                                  |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `server`       | `"src/server.ts"` | The server module                                                                        |
| `client`       | none              | Browser entries; without them, `index.html` is the client entry when the project has one |
| `outDir`       | `"build"`         | The artifact directory                                                                   |
| `backend`      | `"portable"`      | The engine the artifact targets, as in [fetchlet/build](build.md)                        |
| `intl`         | `{}`              | Intl data for engines without native Intl, as in [fetchlet/build](build.md)              |
| `requirements` | `[]`              | APIs beyond the Web API profile, as in [fetchlet/build](build.md)                        |
| `assets`       | `false`           | Pack `client/` into `assets.flpk`; see below                                             |

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## The server module

The default export handles requests with `fetch(request, env, ctx)`, as a
Cloudflare Workers module does. `env` holds the host bindings, and `ctx`
has `waitUntil` and the client address. Named exports are functions that
Rust calls with `App::call` or `AppHandle::call_json`, beside the Fetch
handler. The export name `handle` is reserved for the handler the plugin
generates. A module without a default export builds an artifact of
functions only, as described in
[fetchlet/build](build.md#a-server-module-without-a-framework);
[examples/vanilla-cli](../../../examples/vanilla-cli/README.md) calls one
from a command line program.

```ts
import type { ExportedHandler } from "fetchlet/runtime";

declare module "fetchlet/bindings" {
  interface FetchletBindings {
    MESSAGE: string;
  }
}

export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(audit(request.url));
    return new Response(`${env.MESSAGE} from ${ctx.clientAddress}`);
  },
} satisfies ExportedHandler;

export function greet(name: string): string {
  return `Hello, ${name}`;
}
```

`ctx` has the shape of Workers' `ExecutionContext`: `passThroughOnException()`
does nothing and `props` is empty, since fetchlet has no origin to fall back
to. `ctx.clientAddress` is fetchlet's addition, from the Rust request
context. The SSR environment resolves dependencies with the `worker`
condition and bundles every one of them except `fetchlet/runtime`, which
fetchlet/build adds once before the application when it bundles the output
again for the engine. `node:async_hooks` is not provided; build with
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

## Development serving

`vite dev` with this plugin serves a Rust host that uses fetchlet-http's
`ViteDev` ([fetchlet-http](../../../crates/fetchlet-http/README.md#running-from-a-vite-dev-server)).
The Rust program stays the front door and runs the server module on its own
engine; Vite serves the browser modules with hot module replacement:

- The plugin builds a development artifact for `backend` when the host first
  asks for it. Its server module is `fetchlet/vite/dev-runner`: Vite's module
  runner, which loads the server module from the `ssr` environment through
  the host's `FETCHLET_VITE` binding and evaluates each module with
  `AsyncFunction`. It runs on QuickJS and Boa.
- Before each request or function call, the runner reloads the server
  modules changed since the previous one, with the modules that import them.
  A change to a server module also reloads open pages.
- `virtual:fetchlet/client-assets` gives each browser entry the script
  `/@fetchlet/client?entry=…`, which loads Vite's HMR client and the entry;
  styles come with the modules. The HMR WebSocket connects to Vite's own
  port, which the plugin fixes with `server.strictPort` and
  `server.ws.clientPort` unless the project sets `server.ws`.
- The plugin sets `appType: "custom"`: the server module renders the pages.
- `fetchlet/runtime` is a builtin of the runner: a server module that
  imports it, such as for `upgradeWebSocket`, gets the development
  artifact's copy, so the Web API profile is installed once.

The named exports the host can call are read when the development artifact
is built; a function exported later needs a dev server restart.
[examples/vanilla-axum](../../../examples/vanilla-axum/README.md#develop-from-vite)
has a `dev:vite` task that starts both.

## Without Vite

`exportedHandler` from [fetchlet/build](build.md#a-server-module-without-a-framework)
and the [`fetchlet build`](build.md#the-fetchlet-build-command) command
build the same server module shape without Vite and without browser
entries; the command copies a static directory as the client assets.

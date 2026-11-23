# fetchlet/vinext

A Vite plugin that bundles the App Router server of
[vinext](https://github.com/cloudflare/vinext), an implementation of the
Next.js API on Vite, into a fetchlet artifact. Supports vinext 1;
[examples/vinext-axum](../../../examples/vinext-axum/README.md) checks it; [reference](../../../docs/reference/README.md#examples) records the versions.

```ts
// vite.config.ts
import fetchletVinext from "fetchlet/vinext";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext(), fetchletVinext({ backend: "quickjs" })],
});
```

`backend`, `intl` and `outDir` are the [builder's](build.md) settings.

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Output

The client environment builds directly to `build/client`. After vinext
builds every environment, the plugin writes `build/server.js`, connected to
`dist/server/index.js`, and `build/fetchlet.json`. The rsc and ssr
environments and the rebundle resolve dependencies with
[fetchlet's export conditions](build.md#export-conditions) and `workerd`,
which selects the server builds of React's server packages, such as
`react-dom/server.edge`.

`assets: true` packs the client assets into `assets.flpk` and caches
`_next/static/` for a year ([asset archive](../../../docs/asset-archive.md)).

## Node APIs

vinext's server uses Node APIs on the assumption of Cloudflare Workers'
`nodejs_compat`. `node:buffer`, `node:crypto` and the other modules every
artifact gets come from fetchlet/build ([Node.js compatibility](../../../docs/node-compat.md)).
The plugin replaces the rest in the artifact bundle:

| Module or value | Replacement                                                                         |
| --------------- | ----------------------------------------------------------------------------------- |
| `node:path`     | pathe 2.0.3 (posix and win32)                                                       |
| `node:fs`       | A file system with no files; vinext uses its in-memory cache                        |
| `node:module`   | `createRequire` returning the React entries vinext leaves external in the SSR build |
| `process.env`   | An empty object; `process.platform` is `"linux"`                                    |

fetchlet's runtime allows replacing `globalThis.fetch`, which Next.js's
fetch cache does. The replacement still ends in the host fetch, and Rust's
`FetchPolicy` authorizes every send.

## Request context

```ts
import { getRequestContext } from "fetchlet/vinext/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

It works in server components, route handlers and server actions.
`after()` from `next/server` is connected to `waitUntil`.

## Budgets

On the first request vinext registers a `waitUntil` for each route module
preload. [examples/vinext-axum](../../../examples/vinext-axum/README.md) sets
`background_tasks` to 64; with 8, rendering the first page exceeded the
budget.

The Pages Router, file persistence for ISR, `next/image` optimization and
middleware are not verified. Output of Next.js itself (`next build`) is out
of scope.

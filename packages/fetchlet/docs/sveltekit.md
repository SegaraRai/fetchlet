# fetchlet/sveltekit

A SvelteKit adapter. It bundles the SvelteKit server into a fetchlet
artifact and writes the client assets and manifest. Supports SvelteKit 3 in
both the synchronous (default) and asynchronous rendering profiles;
[examples/sveltekit-axum](../../../examples/sveltekit-axum/README.md) and
[examples/sveltekit-axum-tauri](../../../examples/sveltekit-axum-tauri/README.md)
check them, and [reference](../../../docs/reference/README.md#examples) records the versions.

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: { experimental: { async: false } },
      adapter: fetchletAdapter({ out: "build" }),
    }),
  ],
});
```

The output is `server.js`, `client/` and `fetchlet.json`; the Rust Fetch
entry is `handle`.

| From Rust               | In SvelteKit                 |
| ----------------------- | ---------------------------- |
| Context `clientAddress` | `getClientAddress()`         |
| Fixed bindings          | `platform.env`               |
| `waitUntil`             | `platform.context.waitUntil` |
| String bindings         | `env` of `server.init`       |

Libraries that need WebAssembly do not run on the `quickjs` and `boa`
backends ([engine limits](build.md#engine-limits)).

## Assets

`assets: true` packs the client assets into `build/assets.flpk` and records
it in `fetchlet.json`. Files under `_app/immutable/` get a year of
`Cache-Control: immutable`, and prerendered pages are served without `.html`
or a trailing slash, matching SvelteKit's default `trailingSlash: "never"`.
`assets` settings choose the included files, caching, responses, path rules
and extra entries; a function returns the entries itself (`respond` runs
after the immutable rule). Rust reads the archive with `Artifact::open` or
`include_artifact!` and serves it with `artifact_router`
([asset archive](../../../docs/asset-archive.md)).

## Rendering profiles

| `rendering`               | Use                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `"synchronous"` (default) | Svelte's synchronous rendering; no `node:async_hooks`                                                                 |
| `"async"`                 | Svelte's async rendering (`compilerOptions.experimental.async`) and remote functions (`experimental.remoteFunctions`) |

`"async"` uses the builder's `asyncContext: "serialized"`, so
`getRequestEvent()` and remote forms and queries during rendering see the
current request across `await`. The app runs invocations serially, so the
store belongs to that request. Between remote functions running
concurrently while one request renders, the store of the last started call
is visible. In a remote function's body, call `getRequestEvent()` before the
first `await`.

```ts
sveltekit({
  compilerOptions: { experimental: { async: true } },
  experimental: { remoteFunctions: true },
  adapter: fetchletAdapter({ rendering: "async" }),
});
```

`examples/sveltekit-axum` uses the synchronous profile and
`examples/sveltekit-axum-tauri` the asynchronous one. Promises returned from
`load` stream after the page in the synchronous profile. Server-side asset
reads are next, and remote functions' `query.live` needs long-lived streamed
responses.

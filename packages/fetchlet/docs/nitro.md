# fetchlet/nitro

A Nitro preset that bundles a Nitro server into a fetchlet artifact.
Frameworks built on Nitro, such as Nuxt, produce the same artifact with
`nitro.preset`. Supports nitropack 2 with h3 1;
[examples/nuxt-axum](../../../examples/nuxt-axum/README.md) checks it; [reference](../../../docs/reference/README.md#examples) records the versions.

```ts
/// <reference types="fetchlet/nitro/types" />

export default defineNuxtConfig({
  nitro: {
    preset: "fetchlet/nitro",
    fetchlet: { backend: "quickjs" },
  },
});
```

With Nitro alone, put the same `preset` and `fetchlet` in `nitro.config.ts`.
`fetchlet.backend` and `fetchlet.intl` are the [builder's](build.md)
settings.

## Output

The output directory is `build/`: `server.js`, `client/` (Nitro's public
assets) and `fetchlet.json`, which replaces Nitro's `nitro.json`. The Rust
Fetch entry is `handle`. Nitro's server bundle is built in
`.nuxt/fetchlet/server` (for Nuxt) and rebundled by `fetchlet/build` so it
evaluates after the Web API profile. Rust serves public assets, so Nitro's
`serveStatic` is disabled.

Nitro's worker presets polyfill Node's built-in modules with unenv. The
preset keeps the modules fetchlet implements, and the `Buffer`, `process`,
`setImmediate` and `clearImmediate` globals, as imports for `fetchlet/build`,
so Nitro code gets the same `node:crypto`, `node:async_hooks` and other
modules as every artifact ([Node.js compatibility](../../../docs/node-compat.md)).
unenv still provides the rest. The artifact builds with
`asyncContext: "serialized"`.

`nitro.fetchlet.assets: true` packs the public assets into `assets.flpk`
and caches each `publicAssets` entry that has a `maxAge` (Nuxt's `/_nuxt/`,
for example) for that age ([asset archive](../../../docs/asset-archive.md)).

## Requests and context

- h3's `toWebHandler` passes the Request to Nitro. The request body stays a
  stream as it arrives and can be read with `getRequestWebStream(event)`;
  `readBody` and similar collect it.
- The context's client address becomes `event.context.clientAddress`, which
  h3's `getRequestIP(event)` returns.
- Rust's fixed bindings are `event.context.fetchlet.env`. Applications
  declare their types on [`fetchlet/bindings`](runtime.md#binding-types):

  ```ts
  import type { ServiceBinding } from "fetchlet/bindings";

  declare module "fetchlet/bindings" {
    interface FetchletBindings {
      NUXT_MESSAGE: string;
      RUST: ServiceBinding;
    }
  }
  ```

- String bindings are readable from Nitro's `process.env`; bindings that
  start with `NUXT_` override Nuxt's runtime config.
- `event.waitUntil(promise)` registers with fetchlet's `waitUntil`, within
  Rust's `Limits::background_timeout` and `background_tasks`.
- Nitro-internal calls through `useFetch` and `$fetch` keep
  `event.context.fetchlet` and the client address.

## Tests and next work

[examples/nuxt-axum](../../../examples/nuxt-axum/README.md) checks SSR,
assets, server routes, cookies, runtime config, the Rust service binding,
streaming uploads, `event.waitUntil`, hydration and client navigation on
QuickJS. Rendering uses Vue's `renderToString`, so responses are buffered.

Nitro 3 with h3 2, streaming response bodies, WebSockets and scheduled
tasks are next ([open work](../../../docs/TODO.md#nitro-3-and-h3-2)).

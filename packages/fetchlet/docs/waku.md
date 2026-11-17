# fetchlet/waku

A Waku server entry adapter that bundles Waku's RSC server into a fetchlet
artifact. Verified with waku 1.0.0-rc.5 and React 19.3.1.

```tsx
// src/waku.server.tsx
import adapter from "fetchlet/waku";
import { fsRouter } from "waku";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("/src/pages/**/*.{tsx,ts}")).map(([key, load]) => [
    key.slice("/src/".length),
    load,
  ]),
);

export default adapter(fsRouter(modules), { backend: "quickjs" });
```

`backend`, `intl` and `outDir` are the [builder's](build.md) settings;
`middlewareFns` and `middlewareModules` work as in Waku's other adapters.
Build with `waku build`.

## Output

After Waku's static generation, the adapter writes `build/server.js`,
connected to `dist/server/index.js`, and `build/fetchlet.json`, and moves
`dist/public` to `build/client`. Waku fixes the name `dist/public` and
writes the client build and generated pages there.

`assets: true` packs the client assets into `assets.flpk` and caches
`assets/` for a year ([asset archive](../../../docs/asset-archive.md)).

## Request context

```ts
import { getRequestContext } from "fetchlet/waku/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

It returns the current request's context in server components, server
functions and API routes. Waku passes API handlers a copy of the request, so
call it without arguments. In Hono middleware, `c.env` holds the bindings
and `c.executionCtx.waitUntil` registers work after the response. String
bindings are also readable with Waku's `getEnv(name)`. Waku's
`node:async_hooks` is replaced by the builder's
`asyncContext: "serialized"`.

The app's request budget limits the body; the adapter does not use Hono's
`bodyLimit`.

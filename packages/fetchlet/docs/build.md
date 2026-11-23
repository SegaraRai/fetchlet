# fetchlet/build

Bundles a framework entry into a fetchlet artifact. The bundle initializes,
in order, the Web API profile, the selected polyfills, the native capability
checks and the framework.

## Polyfills per backend

```js
await buildArtifact({
  entry: "./server/entry.js",
  outDir: "./build",
  framework: "my-app",
  backend: "quickjs",
  requirements: ["Intl.DateTimeFormat"],
  intl: {
    locales: ["en", "ja"],
    timeZoneData: "golden",
  },
});
```

`backend` is `quickjs`, `boa`, `v8` or `portable`; choose it to match the
Rust backend. The default, `portable`, assumes no native Intl and includes
implementations that install only where an API is missing. The framework
adapters accept `backend` and `intl` in the same form.

The Intl APIs selected today are `getCanonicalLocales`, `Locale`,
`PluralRules`, `NumberFormat` and `DateTimeFormat`. Applications add
requirements with `requirements` or `intl.apis`, by name, such as
`Intl.NumberFormat`. Adapters and applications state requirements
explicitly instead of the builder inferring them from framework code.

| Build backend    | Intl                                                            |
| ---------------- | --------------------------------------------------------------- |
| `quickjs`, `boa` | FormatJS polyfills for the required APIs and their dependencies |
| `v8`             | Native Intl; FormatJS is left out of the bundle                 |
| `portable`       | Conditional polyfills for the required APIs                     |

The capability table is fixed from measurements of fetchlet's default engine
configurations and checked by regression tests on all three engines; a
future engine feature that changes capabilities updates the table and those
tests together. A `v8` artifact checks the required native APIs and locales
before evaluating the application and asks for a rebuild when the
configuration does not match. These capabilities are the APIs above;
identical behavior across every ECMA-402 proposal and option is a separate
question.

## Engine limits

QuickJS and Boa have no `WebAssembly` global, and no polyfill provides one
at a usable speed, so libraries that compile WebAssembly do not run on the
`quickjs` and `boa` backends. They include image rendering with satori and
resvg, shiki with its Oniguruma engine, and database drivers built to
WebAssembly such as sql.js and PGlite. A library that falls back to
JavaScript when `WebAssembly` is missing takes that path. V8 provides
WebAssembly natively; applications that need such libraries run on the `v8`
backend.

QuickJS and Boa do not expose `SharedArrayBuffer` and `Atomics` either.
The [conformance results](../../../docs/conformance.md) record both.

## Locales and time zones

`intl.locales` defaults to `["en"]`. Only the selected locales' data is
imported; when FormatJS omits a redundant regional file, the parent locale's
data is used. A locale with no usable parent data fails the build. Shared
metadata such as `Intl.Locale`'s, and each formatter's locale data, follow
their dependencies.

`intl.timeZoneData` is `utc` (default), `golden` or `all`: a basic UTC
implementation, FormatJS's representative IANA time zone pack, or every
pack. The polyfill's default time zone is UTC; with `golden` or `all`, set
`timeZone` explicitly to display times independently of the host's default.
Calendars are the pinned FormatJS distribution's basic set (Gregorian and
ISO 8601).

Locale and time zone data is bundled only with polyfills such as
DateTimeFormat; `v8` uses native ICU data. CLDR and time zone updates change
output and past or future offsets, so recheck results when updating
dependencies.

## A server module without a framework

`exportedHandler(module)` returns the entry for a server module in the
Workers module shape: a default export with `fetch(request, env, ctx)` and
named functions beside it. The artifact's Fetch handler calls the default
export's `fetch` with the host bindings as `env`, and `waitUntil` and the
client address on `ctx`; the named exports stay callable from Rust with
`App::call`. The export name `handle` is reserved for the handler.

```ts
import { buildArtifact, exportedHandler } from "fetchlet/build";

await buildArtifact({
  entry: exportedHandler("./src/server.ts"),
  outDir: "./build",
  backend: "quickjs",
});
```

`framework` is optional. [fetchlet/vite](vite.md) builds the same module
shape with Vite, together with browser entries. The types `ExportedHandler`
and `ExecutionContext` come from `fetchlet/runtime`.

A module without a default export builds an artifact of functions only:
`fetchlet.json` records `"handler": null`, and an App built from it with
`fetch_handler(artifact.handler())` fails `fetch` with a configuration error
before running JavaScript, while `call` reaches every export. Such a module
reads the host bindings with `getBindings()` and keeps work open past a call
with `waitUntil()`, both from `fetchlet/runtime`:

```ts
import { getBindings } from "fetchlet/runtime";

export function greet(name: string): string {
  return `${getBindings<{ GREETING: string }>().GREETING}, ${name}`;
}
```

Every artifact's manifest lists the exports Rust can call as `functions`,
which `Artifact::functions()` returns. A server module that itself exports
`handle` fails the build, since that name is reserved for the handler.

## Framework settings

| Setting                      | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asyncContext: "serialized"` | Replaces `node:async_hooks` with an `AsyncLocalStorage` that keeps its store for one invocation. `run` keeps the store until the callback's promise settles; `snapshot` and `bind` capture every storage's value. Each storage keeps its unsettled `run`s in start order and returns the value of the last started one; settled `run`s are removed regardless of order, so overlapping `run`s that settle out of order leave no settled store behind. The app runs invocations serially, so per-invocation context is correct. Within one invocation, concurrent `run`s see the store of the last started `run` (they are not isolated). Implemented in `@fetchlet/node/async-hooks/serialized`, tested by `vp run test:js` |
| `asyncContext: "propagated"` | Replaces `node:async_hooks` with `AsyncLocalStorage` and `AsyncResource` over the engine's async context slot, which carries the context through promise reactions. Concurrent `run`s keep their own stores across `await`, timers and messages, with Node's semantics, including `enterWith` and `disable`. Requires V8 or Boa; the module throws when it loads on QuickJS. Implemented in `@fetchlet/node/async-hooks`, compared with Node's `AsyncLocalStorage` by `vp run test:js`; see the [async context design](../../../docs/research/async-context.md)                                                                                                                                                             |
| `conditions`                 | Conditions added to [fetchlet's export conditions](#export-conditions) for the rebundle, for dependencies the framework left external, such as `workerd`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `plugins`                    | Extra Rolldown plugins for the rebundle; vinext uses them to replace Node APIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `define`                     | Global expressions to replace, in addition to `process.env.NODE_ENV`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The rebundle uses Rolldown and writes one IIFE, `server.js`, with every
dependency included. The entry is a virtual module, so no temporary file is
written next to the sources. `entry` takes a module path or
`{ source, resolveDir }`, whose imports resolve from `resolveDir`; every
adapter passes the entry that connects its framework's server build this
way. Node built-in modules resolve to fetchlet's implementations, and the
`Buffer`, `process`, `setImmediate` and `clearImmediate` globals are imported
into the modules that reference them ([Node.js compatibility](../../../docs/node-compat.md)).
Adapter plugins run first and may replace any of them. Other built-ins resolve
to an npm package of the same name when one is installed, and otherwise to a
stub that loads and throws `ERR_METHOD_NOT_IMPLEMENTED` where it is called.
Without `asyncContext`, `node:async_hooks` is such a stub. Adapters put public files in `client/`; they are
not copied next to `server.js`. The HonoX, TanStack Start, SolidStart, Waku
and vinext adapters, and the SvelteKit adapter with `rendering: "async"`, use
`asyncContext: "serialized"`, since their artifacts may run on any engine.
Both modes are recorded in `fetchlet.json`.

## Export conditions

fetchlet's runtime key for package `exports` is `fetchlet`, following
[WinterTC Runtime Keys](https://runtime-keys.proposal.wintertc.org/). The
rebundle and every adapter's server environment resolve dependencies with

```
fetchlet, worker, module, import, production, default
```

with `development` in place of `production` while Vite serves the app.
`runtimeConditions()` and `runtimeKey` from `fetchlet/build` export them.

- `fetchlet` selects a build made for fetchlet, which may use `env`
  bindings and `fetchlet/runtime`.
- `worker` is the one generic key fetchlet implies: Web APIs as globals,
  with no DOM and no Node.js.
- `workerd`, `edge-light`, `browser` and `node` are not implied. Their
  builds may rely on Cloudflare modules, a platform's edge APIs, the DOM or
  Node.js. An adapter adds one only for the packages that need it, with the
  reason beside it; the vinext adapter adds `workerd` for the server builds
  of React's server packages.

A library that supports fetchlet can list a `fetchlet` entry before its
generic ones:

```json
{
  "exports": {
    ".": {
      "fetchlet": "./dist/fetchlet.js",
      "worker": "./dist/worker.js",
      "default": "./dist/index.js"
    }
  }
}
```

## Asset archives

`archiveArtifactAssets({ outDir, assets })` packs the artifact's assets into
`assets.flpk` and records it under `assets` in `fetchlet.json`. An archive
is a list of entries, one response per URL path, which `writeAssetArchive`
writes as given. `directoryAssets` builds entries from the client directory
and takes `include`, `routes`, `cache` and `respond`. `assets` is `true`,
those settings plus extra `entries`, or a function that returns the
entries. Each framework adapter takes the same `assets` on top of the
framework's defaults, such as `Cache-Control: immutable` for hashed files.
Text is stored with Brotli at quality 11; Rust's `AssetService` sends it as
it is to clients that accept `br` and decompressed to others. [Asset
archive](../../../docs/asset-archive.md) describes the format and rules.

## Artifact

The output is `server.js`, a reference to `client/` and `fetchlet.json`.
Each framework adapter produces the client assets. The manifest records the
backend, required APIs, native assumptions, the polyfills and modules
actually selected, and the locale and time zone settings. Rust's `Module`
takes source only, so selecting by this metadata on the Rust side is open
work ([capability negotiation](../../../docs/TODO.md#capability-negotiation)).

`fetchlet.json` is written last, after `server.js` and `assets.flpk`,
through a temporary file and a rename. A reader that sees a new manifest
sees a complete build; fetchlet-http's `DevReload` relies on this to start
each build `vite build --watch` writes.

The Web API layer stays shared by every backend. Selection by native
capability, started with Intl, extends to other polyfills as their
capability tables and conformance tests are in place. Selecting by native
API presence stays separate from I/O authority and resource ownership.

```bash
vp run test:polyfills
```

The tests cover API dependencies, locale selection, Japanese and Tokyo
output, keeping native constructors, leaving FormatJS out of `v8` builds and
capability mismatches. Module lists and bundle sizes are in
[reference](../../../docs/reference/README.md#polyfills).

The loading order of dependencies and data follows FormatJS's requirements
for [NumberFormat](https://formatjs.github.io/docs/polyfills/intl-numberformat/)
and [DateTimeFormat](https://formatjs.github.io/docs/polyfills/intl-datetimeformat/).

Package resolution for embedded builds uses the `module` and `production`
conditions and the `module` and `main` entries, so it picks JavaScript
implementations that run on embedded engines instead of entries that assume
browser native APIs or Node.

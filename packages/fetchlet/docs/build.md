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

## Framework settings

| Setting                      | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asyncContext: "serialized"` | Replaces `node:async_hooks` with an `AsyncLocalStorage` that keeps its store for one invocation. `run` keeps the store until the callback's promise settles; `snapshot` and `bind` capture every storage's value. Each storage keeps its unsettled `run`s in start order and returns the value of the last started one; settled `run`s are removed regardless of order, so overlapping `run`s that settle out of order leave no settled store behind. The app runs invocations serially, so per-invocation context is correct. Within one invocation, concurrent `run`s see the store of the last started `run` (they are not isolated). Implemented in `src/build/async-hooks.ts`, tested by `vp run test:build` |
| `conditions`                 | Extra package resolution conditions for the rebundle, which resolve dependencies the framework left external to Web-standard entries such as `workerd`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `plugins`                    | Extra Rolldown plugins for the rebundle; vinext uses them to replace Node APIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `define`                     | Global expressions to replace, in addition to `process.env.NODE_ENV`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The rebundle uses Rolldown and writes one IIFE, `server.js`, with every
dependency included. The entry is a virtual module, so no temporary file is
written next to the sources. `entry` takes a module path or
`{ source, resolveDir }`, whose imports resolve from `resolveDir`; every
adapter passes the entry that connects its framework's server build this
way. Node built-in modules that no adapter shims and no npm package of the
same name provides become empty modules, as in Vite's browser build, and
fail where they are called. Adapters put public files in `client/`; they are
not copied next to `server.js`. The HonoX, TanStack Start, SolidStart, Waku
and vinext adapters, and the SvelteKit adapter with `rendering: "async"`, use
`asyncContext: "serialized"`.

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

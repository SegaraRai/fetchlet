# Capability negotiation

An artifact runs only where its host provides what it needs. This page sets
out who decides each part of that, where every input comes from, what the
manifest carries between them, and the checks that make a mismatch fail
early with one clear error.

## Two sides, built apart

```text
 npm toolchain (build time)                 Cargo (compile time)
 ─────────────────────────                  ────────────────────
 framework config + fetchlet adapter        host crate: Cargo.toml + Rust code
 fetchlet, @fetchlet/web, @fetchlet/node    fetchlet, fetchlet-web, fetchlet-http
            │                                          │
            ▼                                          ▼
      artifact/                                 host binary
        server.js                                 engines linked in
        fetchlet.json ──────── the only link ───▶ Web APIs compiled in
                                                       │
                                                       ▼ run time
                                              App build: choose an engine,
                                              check, evaluate server.js
```

The artifact and the host are built by different toolchains, from
different configuration, often at different versions. Neither can see the
other's configuration. The manifest is the only thing that crosses, so
everything the host must know about the artifact's assumptions has to be
in it.

## Principles

1. **Correct by default.** An artifact built with default options runs on
   any host that serves the Web APIs it uses. The default target,
   `portable`, bundles every polyfill, and the FormatJS polyfills install
   only where the engine lacks the API (`polyfill.js` checks
   `shouldPolyfill`). Choosing a specific engine only removes polyfills
   that engine does not need: it is a size optimization, and the
   optimization is what creates an assumption to check.
2. **One place per input.** Every value the build or the host uses has one
   source, listed below. A value is not set in one place and guessed in
   another.
3. **The manifest records assumptions, not settings.** It says what the
   artifact needs from whoever runs it, in terms the host can check
   without knowing how the build reached them.
4. **The host is the authority on itself.** It knows its engines, its
   compiled Web APIs and its protocol. It checks the artifact's needs
   against those before it evaluates any of the artifact's code, and
   reports every miss in one error.
5. **Predictions are tested against facts.** The build's table of what each
   engine provides is a prediction; a test compares it with what each
   engine reports. Nothing is copied between Rust and TypeScript without
   such a test.

## What an artifact can need

| Need          | Examples                                    | Provided by                                               |
| ------------- | ------------------------------------------- | --------------------------------------------------------- |
| Engine API    | `Intl.DateTimeFormat` with `ja` locale data | the engine build (V8 with ICU; QuickJS and Boa have none) |
| Async context | `asyncContext: "propagated"`                | fetchlet's integration of the engine (V8, Boa)            |
| Host Web API  | `crypto`, `compression`, `url-pattern`      | fetchlet-web, by Cargo feature                            |
| Host protocol | fetchlet-web protocol 3                     | fetchlet-web, matched by the bundled `@fetchlet/web`      |

Env bindings are outside this list. The build cannot see which ones an
application reads, and a missing one already fails at first use with a
`TypeError` that names it.

## Where every input comes from

### Build side

| Input                                           | Decided by             | Place                                                                                     | Default     |
| ----------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| Target engine (`backend`)                       | the application author | the adapter's options in the framework config (`vite.config.ts`, `nuxt.config.ts`, …)     | `portable`  |
| Intl data (`intl.locales`, `intl.timeZoneData`) | the application author | the adapter's options                                                                     | `en`, `utc` |
| The application's requirements                  | the application author | **the adapter's options, `requirements`**: one option shared by every adapter             | none        |
| The framework's requirements                    | the adapter            | the adapter's code (Astro: `Intl.DateTimeFormat`)                                         | —           |
| Async context mode                              | the adapter            | the adapter's code (`serialized` for most)                                                | —           |
| Detected requirements                           | the build              | the bundle's imports: `node:crypto` needs `node-crypto`, `node:zlib` needs `compression`  | —           |
| What each target provides natively              | each engine, measured  | `results/polyfill-matrix.json`, written into `engine-capabilities.ts` in `fetchlet/build` | —           |
| Polyfills and engine-only APIs                  | `@fetchlet/web`        | `@fetchlet/web/gaps` and the pinned FormatJS packages it depends on                       | —           |
| Requirement name to host Web API                | `@fetchlet/web`        | a table in the package                                                                    | —           |
| Host protocol the artifact speaks               | `@fetchlet/web`        | its `PROTOCOL_VERSION`                                                                    | —           |

Today the third row is missing: no adapter accepts `requirements`, and
`intl.apis` is a second spelling of the same thing for Intl. The design
adds `requirements` to the options every adapter shares and makes
`intl.apis` an alias for it.

### Host side

| Input                         | Decided by       | Place                                                                                                                         |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Engines available             | the host author  | the host crate's Cargo features of `fetchlet`                                                                                 |
| Web APIs served               | the host author  | the Cargo features of `fetchlet` (`web-apis`, `web-crypto`, …)                                                                |
| Host protocol                 | fetchlet-web     | `fetchlet_web::PROTOCOL_VERSION`                                                                                              |
| Engine APIs present           | the engine build | measured by a probe in each new instance                                                                                      |
| Async context support         | fetchlet         | `Backend`                                                                                                                     |
| Engine that runs the artifact | the host author  | the one engine the host compiles in, or `AxumServer::backend(...)` in Rust; the artifact's `backend` only picks among several |

## The manifest

`fetchlet.json` keeps the settings it records today, for people and tools,
and adds `needs`: the assumptions the host checks.

```json
{
  "backend": "v8",
  "requirements": ["Intl.DateTimeFormat", "crypto"],
  "needs": {
    "engineApis": ["Intl.DateTimeFormat"],
    "locales": ["en", "ja"],
    "asyncContext": false,
    "hostApis": ["crypto", "node-crypto"],
    "hostProtocol": 3
  }
}
```

- `engineApis` lists what the build left to the engine instead of
  bundling, with the `locales` they must support. It is empty for a
  `portable` build.
- `asyncContext` is true for `asyncContext: "propagated"`.
- `hostApis` and `hostProtocol` say what the bundled Web API profile
  expects the host to serve.

The fields are additive, so `formatVersion` stays 1. A host that predates
them ignores them. A host that knows them derives `needs` for an older
artifact from `nativeRequirements`, `intl.locales` and `asyncContext`.

## Build

```text
requirements = adapter options ∪ adapter's own ∪ detected from imports
        │
        ▼  each requirement, by the catalog:
   native on the target ─────────▶ needs.engineApis
   polyfillable ─────────────────▶ bundled (installs only where missing)
   host Web API ─────────────────▶ needs.hostApis
   unknown, or engine-only and
   missing on the target ────────▶ build error
        │
        ▼
server.js: Web API profile → polyfills → native check → framework
fetchlet.json: written last, with needs
```

An unknown requirement fails the build instead of being ignored, as it is
today. The catalog grows beyond Intl as each polyfill gains conformance
tests. The native check stays in the bundle for hosts that load
`server.js` without reading the manifest.

## Run

```text
Artifact::open ──▶ Requirements from needs
        │
        ▼  the engine the host author chose
        │
        ▼  per instance, before server.js
   Web APIs and protocol   vs  fetchlet-web build
   async context           vs  Backend
   engine APIs, locales    vs  probe in the new instance
        │
        ├─ all met ──▶ evaluate server.js
        └─ missing ──▶ Error::Configuration naming every miss
```

The core crate takes the needs as a value and knows nothing of the
manifest format, which fetchlet-http owns:

```rust,ignore
let app = App::builder(backend)
    .module(Module::new(artifact.server_source()?).requires(artifact.requirements()))
    .build()?;
```

- `Requirements` holds names. A name the host does not know counts as
  missing, so a newer artifact cannot pass by naming something an older
  host never heard of.
- A host normally compiles in one engine, the one it means to run, so
  fetchlet does not pick an engine for the artifact. The check answers the
  question that matters: does the artifact run on that engine.
- `AxumServer`, `DevReload` and `ViteDev` pass the artifact's requirements.
  Under `DevReload` a refused build is reported and the previous one keeps
  serving, as with any failed build.

The error names what is missing and what to do, for example: `the artifact
needs native Intl.DateTimeFormat (en, ja), which the QuickJS backend lacks;
build it for quickjs or portable, or run it on V8`.

## What changes

| Today                                                           | After                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| No adapter accepts `requirements`; `intl.apis` covers Intl only | `requirements` in every adapter's options; `intl.apis` is an alias |
| Requirements outside `Intl.` are ignored                        | each is sorted by the catalog; unknown ones fail the build         |
| Imports of `node:crypto` or `node:zlib` record nothing          | they add host Web APIs to `needs`                                  |
| Rust reads `backend` only to pick the engine                    | Rust reads `needs` and checks them against the engine it runs      |
| An overridden engine is not compared with the target            | it is checked before `server.js` runs                              |
| A missing Web API leaves a global undefined                     | the App build fails and names it                                   |
| A missing native Intl API throws inside the bundle              | the App build fails before evaluation, with Rust's error           |

## Ownership of the tables

| Table                            | Owner                          | Kept true by                                                                                |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| Native APIs per target           | the probe on each engine       | `test:polyfills` records it; `check:generated` fails when `engine-capabilities.ts` is stale |
| Polyfills and dependencies       | `@fetchlet/web/gaps`           | pinned FormatJS releases and conformance tests                                              |
| Requirement name to host Web API | `@fetchlet/web`                | a test against `web.capabilities`                                                           |
| Web APIs a host serves           | `fetchlet_web::capabilities()` | Cargo features                                                                              |
| Async context per engine         | `Backend`                      | `tests/async_context.rs` on each engine                                                     |

## Order of work

1. **Host check** (implemented). `Requirements`, `Module::requires` and the probe in
   `fetchlet`, with tests for each kind of miss alone and together on every
   engine.
2. **Artifact to host** (implemented). `Artifact::requirements` from the existing fields,
   used by the servers; a test that an artifact built for another engine is
   refused.
3. **Declared needs** (implemented). `requirements` in the shared adapter options,
   detection from `node:*` imports, `needs` in the manifest, and build
   errors for unknown requirements.
4. **More polyfills.** Each joins the catalog with its conformance tests.
   The catalog distinguishes polyfills from engine-only APIs, and holds every
   Intl API FormatJS implements: ListFormat, DisplayNames,
   RelativeTimeFormat, Segmenter and DurationFormat joined the first five.
   Polyfills beyond Intl follow.

## Limits

- The check covers what is declared or detected. An application that uses
  a global it never declared still fails where it first uses it.
- Engine APIs are checked for presence and, for Intl, locale support, not
  for conformance, which [conformance](../conformance.md) covers.
- Hosts older than this design run artifacts unchecked, as they do today.

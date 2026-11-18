# Open work

This file contains unresolved design and validation work. Current supported
frameworks, configuration and limitations are documented with their adapters.
Each item below identifies a remaining limitation and the evidence needed to
resolve it.

## Future framework support

### Solid 2

`fetchlet/solid-start` supports SolidStart 2.2.3, which requires `solid-js`
^1.9.15 and `@solidjs/router` below 2. The workspace catalog therefore keeps
`solid-js` 1.9.19, `@solidjs/router` 1.0.3 and `@solidjs/meta` 0.29.8, the
`v1-latest` releases, although Solid 2.0.0, Solid Router 2.0.0 and Solid Meta
2.0.0 are published. When a SolidStart release accepts Solid 2, move the
catalog to it, update `examples/solidstart-axum` to the Solid 2 APIs, and pass
its end-to-end checks on QuickJS. Then widen the `@solidjs/start` peer range if
the adapter keeps supporting the previous line.

### Nitro 3 and h3 2

`fetchlet/nitro` is a Nitro 2 preset. Its runtime imports `toWebHandler` from
h3 and its declarations augment h3's event context, so the package declares
`h3` ^1.0.0 as an optional peer that shares the h3 instance nitropack 2 uses.
Nuxt 4.6.4 runs on nitropack 2, which `examples/nuxt-axum` verifies.

h3 2 belongs to Nitro 3 (`nitro` on npm, at release candidate stage). Supporting
it means a Nitro 3 preset: decide whether it extends `fetchlet/nitro` or takes
its own subpath, port the runtime entry and the context augmentation to h3 2,
and add an example on a framework that runs on Nitro 3. Widen the `h3` peer to
`^1.0.0 || ^2.0.0` only when both presets are verified. SolidStart 2 and
TanStack Start already use h3 2 internally; their adapters do not import h3,
so they are unaffected.

Sources: [SolidStart adapter](../packages/fetchlet/src/integrations/solid-start/index.ts),
[Nitro runtime](../packages/fetchlet/src/integrations/nitro/runtime/nitro.ts),
[Nitro declarations](../packages/fetchlet/src/integrations/nitro/types.d.ts),
[workspace catalog](../pnpm-workspace.yaml).

## Runtime

### WinterTC gaps

The [WinterTC table](web-api.md#wintertc-minimum-common-api) lists what the
profile lacks. In rough order of how often server code needs them:

- Global error events: make the global scope an `EventTarget`, dispatch
  `ErrorEvent` from `reportError` and `PromiseRejectionEvent` for
  unhandled rejections where each engine exposes a rejection tracker.
- `MessageChannel`, `MessagePort` and `MessageEvent` within one instance,
  which React's scheduler and some libraries detect.
- WebAssembly on QuickJS and Boa has no practical provider; record it as an
  engine limit.

### Capability negotiation

`fetchlet.json` records the target backend, required APIs and chosen
polyfills, but `Module` takes only source, so Rust does not compare them with
the engine it runs. Add a check at build time of the `App` that refuses an
artifact whose requirements the backend lacks, and extend the capability
table beyond Intl as each polyfill gains conformance tests.

### Enforcement and isolation

Deadlines are cooperative. Stopping JavaScript that never yields, stopping
initialization and bounding the whole heap need per-engine interrupts and
heap limits, and third-party code needs a process boundary. Each engine's
mechanism needs a regression test that stops a non-yielding script and
retires the instance.

### Instance pools

`App` and `AppHandle` run one instance serially. A pool would key compiled
code by code, engine version and profile, and reuse instances only within
one application, tenant and authority configuration. Reentrancy under a
pool (waiting for capacity) and calls from tasks spawned by host futures,
which are not detected today, need defined behavior and tests.

### Streaming outbound request bodies

Outbound request bodies are read in full in JavaScript because a redirect
may resend them. Streaming them needs rules for when a redirect may resend,
and tests for cancellation and budgets on that path.

### Context for function calls

The trusted `Context` reaches host fetches made during `fetch`. `App::call`
and `call_json` have no way to pass one; add an entry point and cover it in
`crates/fetchlet/tests/in_process.rs`.

### Values beyond JSON

Function arguments and results are JSON-compatible values. Handles and host
resources need a boundary with explicit ownership and lifetime.

## Frameworks

### Internal fetch per framework

The split between framework-internal fetches and host fetches is verified
for SvelteKit's `event.fetch`. Verify it for each other adapter and record
the result in its guide.

### React Router

Split server bundles, prerendering and RSC mode are not supported by
`fetchlet/react-router`; each needs its own example checks.

### Asynchronous SvelteKit SSR

`rendering: "async"` runs Svelte's experimental async SSR with the
serialized `AsyncLocalStorage`. Concurrent `run` calls within one invocation
share the last started store; isolating them needs engine support for async
context or a different scheduler.

## Distribution

### Tauri

Installers built with `tauri build`, bundling the build directory as a
resource, and builds on macOS (WKWebView) and Linux (WebKitGTK) are not
verified. examples/sveltekit-axum-tauri also reads its configuration from a
file next to the binary; defaults compiled into the binary would make `mdw`
distributable alone.

### Measurements

Startup time, time to first content, distribution size, RSS and latency
under load have not been measured per engine and polyfill selection. Measure
them on the same application, compare with a static build of the same pages,
and use the results to recommend `Limits` values.

### Windows CRT

All-feature links on Windows warn `LNK4098 libcmt.lib`. Settle the CRT
configuration before release.

## Conformance

Test262 host features, negative and module tests, writable, transform and
piping Streams, the no-cors header guard, legacy multi-byte encodings, and
fuzzing of JavaScript multipart and Body parsing are next
([conformance](conformance.md#next)).

## Unit tests

Integration, conformance and example end-to-end suites cover whole artifacts.
Code that runs on the user's side also needs unit tests that pin its own
decisions. Vitest covers `fetchlet/build` (`buildArtifact`, polyfill planning,
asset entries and options), the runtime Fetch handler, every framework
integration's options, generated entry, middleware and context helpers, and
the host-independent logic of `@fetchlet/web`: Web IDL conversions,
`multipart/form-data` parsing, wire conversion with the response body
registry, the host protocol and Web Cryptography algorithm normalization.
Next:

- `@fetchlet/web` classes that install as globals, such as Headers, Body and
  URL with a fake host parser, tested directly once the modules export their
  implementations.
- Rust: archive and artifact manifest parsing in `fetchlet-http`, and limit and
  error mapping in `fetchlet`, as module tests beside the code.

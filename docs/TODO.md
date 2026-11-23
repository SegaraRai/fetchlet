# Open work

This file contains unresolved design and validation work. Current supported
frameworks, configuration and limitations are documented with their adapters.
Each item below identifies a remaining limitation and the evidence needed to
resolve it.

## Future framework support

### Vanilla JavaScript

[fetchlet/vite](../packages/fetchlet/docs/vite.md) and `exportedHandler` in
[fetchlet/build](../packages/fetchlet/docs/build.md#a-server-module-without-a-framework)
build a server module in the Workers module shape, which
`examples/vanilla-axum` checks; a module of functions only builds an
artifact without a Fetch handler, which `examples/vanilla-cli` checks.
`vite dev` serves the same module through fetchlet-http's `ViteDev`
([development loop](research/dev-loop.md)). One part remains:

- A command line entry, `fetchlet build src/server.ts --backend quickjs
  --out build`, for projects without Vite. It needs a `bin` in the package
  and a check in `test:package` that runs the packed command.

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

Sources: [shared Vite plugin](../packages/fetchlet/src/integrations/vite/server-environment.ts),
[exportedHandler](../packages/fetchlet/src/build/exported-handler.ts),
[artifact manifest](../crates/fetchlet-http/src/artifact.rs),
[Nitro runtime](../packages/fetchlet/src/integrations/nitro/runtime/nitro.ts),
[Nitro declarations](../packages/fetchlet/src/integrations/nitro/types.d.ts).

## Runtime

### Framework runtime needs beyond WinterTC

Framework servers and their common dependencies also expect APIs outside
the Minimum Common API. Each item needs a decision, an implementation or a
documented refusal, and a check in a framework example:

- Concurrent request context. Next.js, SvelteKit's `getRequestEvent`, Nuxt
  through unctx, SolidStart and TanStack Start keep the request in
  `AsyncLocalStorage`. `asyncContext: "propagated"` isolates concurrent
  `run` calls on V8 and Boa ([async context design](research/async-context.md)),
  but every framework adapter still builds with `"serialized"`, which shares
  the last started store (see
  [Asynchronous SvelteKit SSR](#asynchronous-sveltekit-ssr)). QuickJS has
  no async context slot, so `"serialized"` stays as the mode every engine
  runs until QuickJS gains one.
  - Wait for quickjs-ng to merge and release a way to carry a value through
    promise jobs ([issue #1919](https://github.com/quickjs-ng/quickjs/issues/1919),
    [pull request #1920](https://github.com/quickjs-ng/quickjs/pull/1920))
    and for an rquickjs release that includes it.
  - Once that rquickjs release is out, in one change: update rquickjs,
    implement the QuickJS slot over the new API with the engine tests and
    matrix check passing on QuickJS, switch every adapter to
    `"propagated"`, and remove `"serialized"`: the option value,
    `packages/node/src/async-hooks-serialized.ts`, its
    `@fetchlet/node/async-hooks/serialized` export, its tests and the
    documentation that describes it. Propagation then applies to every
    artifact, so the `asyncContext` option, its `fetchlet.json` field and
    the `node:async_hooks` stub for builds without it go too.
  - In the same change, verify the asynchronous SvelteKit example on every
    engine with an end-to-end check that two concurrent `getRequestEvent`
    readers each see their own request.
  - Before that change, measure `run`, `getStore` and an `await` loop per
    engine against the serialized implementation.
- Stubs for V8's `Error.captureStackTrace` and `Error.prepareStackTrace` on
  QuickJS and Boa, which libraries such as depd call at load time.
- A runtime key for package `exports`: choose fetchlet's condition name
  following WinterTC Runtime Keys and which of `worker`, `edge-light` and
  `workerd` it implies, so adapters stop adding conditions one by one.

Streaming outbound request bodies, Intl coverage checks and legacy
multi-byte encodings are tracked under
[Streaming outbound request bodies](#streaming-outbound-request-bodies),
[Capability negotiation](#capability-negotiation) and
[Conformance](#conformance).

Deferred until an adapter or application needs them:

- The Cache API (`caches`), which some edge adapters use for ISR and fetch
  caching. It would map to a cache store configured in Rust, with an
  in-memory default, as an optional fetchlet-web API.
- `SharedArrayBuffer` and `Atomics` on QuickJS and Boa, which some
  WebAssembly builds and libraries detect.

### Host channels and resources

Connections go through Rust, as fetch does: the network stays in the host,
and JavaScript gets one channel primitive with the APIs built on it.
[Host channels and resources](research/host-channels.md) designs the handle
table, the two channel lifetimes (request-scoped, and held connections that
keep their invocation and instance until they close) and the order of work.

The handle table, request-scoped channels and held connections are
implemented: `HostServices::channel` with `env.NAME.connect()` and its
WebSocket and stream views, `upgradeWebSocket` from `fetchlet/runtime`,
`Instances::max_held_connections`, the channel and connection budgets,
server upgrades in fetchlet-http's axum and actix integrations behind the
`websocket` and `actix-websocket` features and under `ViteDev`, a WebSocket
route with an end-to-end check in every axum example,
`connect()` over a `SocketService` with fetchlet-net's `TcpTransport`, and
the global `WebSocket` over a `WebSocketService` with fetchlet-net's
`WebSocketClient`, `Stream` and `Sink` for `ChannelEnd`, and channels Rust
lends to a call with `Call` ([status](research/host-channels.md#status)).
Resources in results remain ([values beyond JSON](#values-beyond-json)).

Several connections per instance wait until async context is available on
every engine ([concurrent request context](#framework-runtime-needs-beyond-wintertc)).

### Capability negotiation

`fetchlet.json` records the target backend, required APIs, chosen polyfills,
the Fetch handler and the exported functions. Rust reads the handler, so an
App built from an artifact of functions only refuses `fetch`, but `Module`
takes only source, so Rust does not compare the rest with the engine it runs.
Add a check at build time of the `App` that refuses an artifact whose
requirements the backend lacks, and extend the capability table beyond Intl as
each polyfill gains conformance tests.

### Enforcement and isolation

Deadlines are cooperative. Stopping JavaScript that never yields, stopping
initialization and bounding the whole heap need per-engine interrupts and
heap limits, and third-party code needs a process boundary. Each engine's
mechanism needs a regression test that stops a non-yielding script and
retires the instance.

### Instance pools

`WorkerOptions::instances` runs several instances behind one `AppHandle`,
each running one invocation at a time, with a shared queue, growth to `max`
and retirement after `idle_timeout` (`crates/fetchlet/tests/pool.rs`).
[Instance pools](research/instance-pools.md) designs the rest:

`AppBuilder::host_runtime` runs what host transports spawn on a shared
runtime, which fetchlet-http's `Server` passes
(`crates/fetchlet/tests/host_runtime.rs`). `Server::instances` sets the pool
for a server, and [sizing](research/instance-pools.md#sizing) records the
throughput by pool size that its recommendation rests on.

1. Compiled code caching, if measurements show build time matters.
2. Pool state for operators, such as instances by state and queue length,
   held connections included, so a deployment can size `max` from its own
   load.
3. Seed each QuickJS context from host entropy. QuickJS seeds
   `Math.random` and its property hash seed from the time in microseconds,
   and quickjs-ng has no API to set them, so instances that a pool builds at
   the same moment on two threads, such as a replacement and a new instance,
   can share both. The spawn builds its instances one after another for this
   reason. quickjs-ng [pull request #1931](https://github.com/quickjs-ng/quickjs/pull/1931)
   seeds both from operating system entropy and adds a `random_bytes` hook
   for embedders; once an rquickjs release includes it, update rquickjs and
   start the spawn's instances together again.

Concurrent invocations within one instance wait until async context is
available on every engine.

### zstd for outbound fetch

`HttpClient` asks for and decodes gzip, deflate and Brotli. Browsers also
accept `zstd`; adding it needs a pure Rust decoder, or a C dependency the
release builds accept, with output bounded per piece as the other codings
are.

### Streaming outbound request bodies

Outbound request bodies are read in full in JavaScript because a redirect
may resend them. Streaming them needs rules for when a redirect may resend,
and tests for cancellation and budgets on that path.

### Context for function calls

The trusted `Context` reaches host fetches made during `fetch`. `App::call`
and `call_json` have no way to pass one; add an entry point and cover it in
`crates/fetchlet/tests/in_process.rs`.

### Channels in function arguments

`Functions` methods take byte arrays in their arguments and return byte
arrays and channels, but JavaScript cannot pass a channel it holds to a
method. Moving one to Rust needs a relay in the handle table between
JavaScript's end and a new `ChannelEnd`, and rules for sockets, whose ends
also carry `startTls` and the end of writes, and for an accepted upgrade.
Add it when a binding needs to take over a channel, such as a WebSocket
the handler accepted.

### Values beyond JSON

`Call` lends channels to a function call at JSON Pointer positions of its
arguments; results are JSON-compatible values. Channels returned from a
call would follow [the design](research/host-channels.md#values-beyond-json):
the bridge lists the positions of its own channel objects beside the JSON
and moves those channels to Rust. Add them when an embedder needs a call to
hand back a channel it opened.

## Frameworks

### Internal fetch per framework

The split between framework-internal fetches and host fetches is verified
for SvelteKit's `event.fetch`. Verify it for each other adapter and record
the result in its guide.

### Development reload per framework

Every axum and Tauri example has a `dev` task that rebuilds on source
changes while `DevReload` serves each build
([development loop](research/dev-loop.md)), through the `fetchlet dev`
command ([dev](../packages/fetchlet/docs/dev.md)). vanilla-axum,
tanstack-start-axum, solid-axum and solidstart-axum keep
`vite build --watch` running instead. One part remains:

- Two integrations are inconsistent under `vite build --watch`
  ([results](research/dev-loop.md#a-watch-build-and-artifact-reload)):
  vinext writes the manifest before its frontend, and SvelteKit does not
  build new routes; [both need upstream changes](research/dev-loop.md#why-the-integrations-differ-under---watch).
  Their examples' `dev` tasks keep full builds until then.

### Development reloads under `ViteDev`

A new instance under `ViteDev` fetches and evaluates every module from Vite
again. Cancelled requests no longer cause one (`CancelledCalls::Finish`),
but a call past its deadline still does, and host bodies are now read whole
([measurements](research/dev-loop.md#why-a-cancelled-request-costs-a-module-reload)).
Keeping the runner's transformed modules in Rust across instances would
save the remaining transport; time an Astro reload on QuickJS first to see
what is left of the 2.4 seconds.

### Waku streaming on Boa

`Waku streams deferred content after the shell` fails intermittently on
Boa: the first chunk already holds the value its page resolves after 200 ms,
so the shell reached the client later than that. It failed in each of three
`vp run test:examples -- waku-axum --backends boa` runs on the tree of
fc330e7, and in one of three runs of the acceptance suite against the
build of df94d4f on the same machine; QuickJS and V8 pass. Find where the
shell waits on Boa (rendering time, the first response chunk, or the
pull of the body) before deciding whether the page's delay or the engine
path changes. `results/example-waku-axum-boa.json` keeps the passing run
of df94d4f.

### React Router

Split server bundles, prerendering and RSC mode are not supported by
`fetchlet/react-router`; each needs its own example checks.

### Asynchronous SvelteKit SSR

`rendering: "async"` runs Svelte's experimental async SSR with the
serialized `AsyncLocalStorage`. Concurrent `run` calls within one invocation
share the last started store. Building it with `asyncContext: "propagated"`
isolates them on V8 and Boa; see
[concurrent request context](#framework-runtime-needs-beyond-wintertc).

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

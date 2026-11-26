# Open work

This file contains unresolved design and validation work. Current supported
frameworks, configuration and limitations are documented with their adapters.
Each item below identifies a remaining limitation and the evidence needed to
resolve it.

## Future framework support

### Nitro 3 and h3 2

`fetchlet/nitro` is a Nitro 2 preset. Its runtime imports `toWebHandler` from
h3 and its declarations augment h3's event context, so the package declares
`h3` ^1.0.0 as an optional peer that shares the h3 instance nitropack 2 uses.
Nuxt 4.6.4 runs on nitropack 2, which `examples/nuxt-axum` verifies.

h3 2 belongs to Nitro 3 (`nitro` on npm, a release candidate since
October 2026), which no framework release depends on yet; SolidStart 2 and
TanStack Start use h3 2 without Nitro, and their adapters do not import h3.
[A Nitro 3 preset](research/nitro-3.md) records what changes: the `nitro`
package, `nitroApp.fetch`, the context on the Request as h3 2 reads it, and
the renamed bundler hook. Build it as `fetchlet/nitro3` against the release
candidate with an example built with `nitro/vite`, and publish it once
Nitro 3 is stable. Widen the `h3` peer to `^1.0.0 || ^2.0.0` only when both
presets are verified.

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
  - In the same change, measure the QuickJS slot with fetchlet-bench's
    `async-context` tool against the serialized implementation, as
    [measured on V8 and Boa](research/async-context.md#cost).

Intl coverage checks and legacy multi-byte encodings are tracked under
[Capability negotiation](#capability-negotiation) and
[Conformance](#conformance).

Deferred until an adapter or application needs them:

- The Cache API (`caches`), which some edge adapters use for ISR and fetch
  caching. It would map to a cache store configured in Rust, with an
  in-memory default, as an optional fetchlet-web API.

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
Channels that JavaScript holds do not yet move to Rust
([moving JavaScript channels to Rust](#moving-javascript-channels-to-rust)).

Several connections per instance wait until async context is available on
every engine ([concurrent request context](#framework-runtime-needs-beyond-wintertc)).

### Capability negotiation

`Module::requires` checks a module's `Requirements` (native engine APIs
and locales, async context, fetchlet-web APIs and protocol) against the
engine before the module runs. Builds record them as `needs` in
`fetchlet.json`, from the shared `requirements` option and `node:*`
imports, and `Artifact::requirements` reads them back. The polyfill catalog
(`@fetchlet/web/gaps`) covers every Intl API FormatJS implements, and names the engine-only APIs
(`Intl.Collator`, `Intl.supportedValuesOf`, `WebAssembly`,
`SharedArrayBuffer`, `Atomics`). Next, following
[capability negotiation](research/capability-negotiation.md): polyfills
beyond Intl as applications need them, each with its tests on every engine.

### Enforcement and isolation

The invocation deadline, `Limits::busy_timeout` and
`Limits::startup_timeout` stop non-yielding JavaScript on QuickJS and V8.
Boa stops it at its next promise job or host call and bounds loops with
`BoaOptions::loop_iteration_limit`; JavaScript that does neither, such as
deep recursion, runs on, so untrusted code belongs on QuickJS, V8 or behind
a process boundary. QuickJS and V8 stop an instance at its heap limit; Boa
has none.
Every stop retires the instance and has a regression test on each engine.
Third-party code still needs a process boundary. On V8, some hot loops that
allocate are stopped only with `V8Options::reliable_termination`, which is
off by default; report that gap to V8 with the loop as a reproduction
([the V8 termination gap](research/interrupts-and-heap-limits.md#the-v8-termination-gap)).
[Process isolation](research/process-isolation.md) designs that boundary:
each instance's engine in a child process behind the bridge, with host
services kept in the parent, a kill timer and OS memory limits on every
engine, and optional sandbox profiles. `AppBuilder::isolation` and
fetchlet-http's `Server::isolation` run it behind the `process` feature,
with the memory budget on Windows, Linux and macOS. Next are the
measurements on Linux, running the isolation tests on macOS, then the
sandbox profiles and carrying taken bytes in replies.

### Instance pools

`WorkerOptions::instances` runs several instances behind one `AppHandle`,
each running one invocation at a time, with a shared queue, growth to `max`
and retirement after `idle_timeout` (`crates/fetchlet/tests/pool.rs`).
[Instance pools](research/instance-pools.md) designs the rest:

`AppBuilder::host_runtime` runs what host transports spawn on a shared
runtime, which fetchlet-http's `Server` passes
(`crates/fetchlet/tests/host_runtime.rs`). `Server::instances` sets the pool
for a server, and [sizing](research/instance-pools.md#sizing) records the
throughput by pool size that its recommendation rests on. On QuickJS and
V8, the instances built from one `AppBuilder` reuse the first one's compiled
code ([startup and memory](research/startup-and-memory.md#compiled-code-caching)).
`AppHandle::pool_state` reports instances by state, the queue, held
connections and build and retirement totals for operators.

1. Seed each QuickJS context from host entropy. QuickJS seeds
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

### Moving JavaScript channels to Rust

Byte arrays cross both ways in calls and function bindings, and Rust lends
channels to both, but a channel JavaScript holds cannot move to Rust: not
as an argument of a `Functions` method, nor in the result of an exported
function. Both need the same relay in the handle table between
JavaScript's end and a new `ChannelEnd`, as
[the design](research/host-channels.md#values-beyond-json) describes, and
rules for sockets, whose ends also carry `startTls` and the end of writes,
and for an accepted upgrade. Until then a method can return a channel that
JavaScript writes to, and Rust can lend one to a call, which covers the
known uses. Add it when a binding needs to take over a channel JavaScript
opened, such as a WebSocket the handler accepted.

## Frameworks

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

### React Router

[React Router build modes](research/react-router-modes.md) records what
each needs. Split server bundles stay refused until an application needs
one App per bundle, and RSC mode needs a Vite plugin like `fetchlet/vinext`
once React Router stabilizes it.

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

### Engine memory

[Startup and memory](research/startup-and-memory.md) measured build time,
memory, latency and size for every example on each engine and recommends
settings from them. QuickJS and V8 stop an instance at its heap limit, so a
pool's `max` times the limit bounds its memory there; Boa has no allocation
limit ([enforcement and isolation](#enforcement-and-isolation)).

The measurements cover a page per request on fresh instances; measure the
heap of a long-running instance under varied pages before raising the
recommended limits.

## Conformance

Test262 host features, negative and module tests, writable, transform and
piping Streams, the no-cors header guard, legacy multi-byte encodings, and
fuzzing of JavaScript multipart and Body parsing are next
([conformance](conformance.md#next)).

# fetchlet documentation

## Concepts

- [Overview](overview.md): purpose, use cases, principles and scope.
- [Domain model](domain-model.md): App, Instance, Invocation, host services
  and artifacts, and who owns what.
- [Data flow](data-flow.md): a build, a request, a response body and an
  outbound fetch, step by step.

## Using fetchlet from Rust

- [fetchlet crate](../crates/fetchlet/README.md): `App`, `AppHandle` and
  engine selection.
- [fetchlet-http crate](../crates/fetchlet-http/README.md): Tower, hyper,
  axum and actix integration, artifacts and errors.
- [fetchlet-net crate](../crates/fetchlet-net/README.md): the HTTP, TCP,
  TLS and WebSocket transports of JavaScript's outbound fetch, sockets and
  WebSockets.
- [fetchlet-web crate](../crates/fetchlet-web/README.md): engine-independent
  host implementations of Web APIs and their features.
- [Host services](host-services.md): env, services, console, outbound fetch
  and transports.
- [In-process fetch](in-process-fetch.md): calling Rust routers from
  JavaScript with a trusted Context.
- [Resource policy](resource-policy.md): caller budgets and fixed limits.
- [Embedding and distribution](embedding.md): single binaries and Tauri.
- [Asset archive](asset-archive.md): the `assets.flpk` format and how it is
  served.

## Building JavaScript

- [fetchlet npm package](../packages/fetchlet/README.md): subpaths and
  framework adapters.
- [fetchlet/build](../packages/fetchlet/docs/build.md): artifacts and
  polyfill selection.
- [fetchlet/runtime](../packages/fetchlet/docs/runtime.md): the Fetch entry
  and bindings.
- [fetchlet dev](../packages/fetchlet/docs/dev.md): the command that
  rebuilds an artifact on source changes while the Rust host serves each build.
- [Web API profile](web-api.md): what the profile provides on every engine,
  implemented in [@fetchlet/web](../packages/web/README.md).
- [Node.js compatibility](node-compat.md): the `node:*` modules and globals
  every artifact gets, implemented in [@fetchlet/node](../packages/node/README.md).
- [Examples](../examples/README.md): runnable applications per framework.

## Security and verification

- [Security](security.md): the execution boundary, isolation and fuzzing.
- [Conformance](conformance.md): WPT, Test262 and known differences.
- [Verification](verification.md): test suites and environment.
- [Reference](reference/README.md): measured results, generated from
  `results/`.
- [Releasing](releasing.md): change intents, the shared version of the npm
  packages and crates, and the release workflows.

## Planning and research

- [Open work](TODO.md): remaining limitations and the evidence that would
  resolve them.
- [Instance pools](research/instance-pools.md): several instances behind
  one `AppHandle`, scheduling, held instances and reentrancy.
- [Startup, memory and compiled code caching](research/startup-and-memory.md):
  build time, memory, latency and size per framework and engine, the effect
  of caching compiled code, and the `Limits` they recommend.
- [Host channels and resources](research/host-channels.md): the design of
  handles, host channels, `connect()`, `WebSocket` and server upgrades.
- [Web API implementations](research/web-api-implementations.md): a survey
  of LLRT, Deno and Boa runtimes.
- [URL parsing in the host](research/host-url-parser.md): the measurement
  behind moving URL parsing to Rust.
- [Ahead-of-time compilation](research/native-aot.md): a concluded
  investigation of Perry and scriptc.
- [Development loop](research/dev-loop.md): options for editing a framework
  app while the Rust host keeps running.
- [Async context propagation](research/async-context.md): the design for
  isolating concurrent `AsyncLocalStorage` runs on every engine.
- [Capability negotiation](research/capability-negotiation.md): checking
  an artifact's engine and host requirements when an App is built.
- [Interrupts and heap limits](research/interrupts-and-heap-limits.md):
  what each engine provides to stop JavaScript that never yields and to
  bound its heap, and the design built on it.

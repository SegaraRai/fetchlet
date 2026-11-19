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

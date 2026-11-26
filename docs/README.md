# fetchlet documentation

The user documentation is the website at <https://fetchlet.roundtrip.dev/docs>.
Its sources are in [apps/website/src/content/docs/](../apps/website/src/content/docs/),
and [the website's development notes](../apps/website/DEVELOPMENT.md) describe
how it is built and how its pages are written. The `fetchlet` npm package ships
the same pages as Markdown in `docs/`, for coding agents.

This directory holds the documentation for maintainers.

## Verification and releases

- [Conformance](conformance.md): WPT, Test262, how to run them, and known
  differences.
- [Verification](verification.md): test suites and environment.
- [Security testing](security-testing.md): the regression tests, fuzz
  targets and continuous checks of the execution boundary.
- [Reference](reference/README.md): measured results, generated from
  `results/`.
- [Releasing](releasing.md): change intents, the shared version of the npm
  packages and crates, and the release workflows.

## Packages and crates

- [fetchlet npm package](../packages/fetchlet/README.md),
  [@fetchlet/web](../packages/web/README.md) and
  [@fetchlet/node](../packages/node/README.md).
- [fetchlet](../crates/fetchlet/README.md),
  [fetchlet-http](../crates/fetchlet-http/README.md),
  [fetchlet-net](../crates/fetchlet-net/README.md) and
  [fetchlet-web](../crates/fetchlet-web/README.md) crates.
- [Examples](../examples/README.md): runnable applications per framework.

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
- [Process isolation](research/process-isolation.md): running each
  instance's engine in a child process, so that deadlines, cancellation and
  memory budgets hold on every engine and an engine crash stays contained.
- [React Router build modes](research/react-router-modes.md): what
  prerendering, split server bundles and RSC mode need from the preset.
- [A Nitro 3 preset](research/nitro-3.md): what Nitro 3 and h3 2 change
  for `fetchlet/nitro`, and when to build the preset.
- [The C runtime on Windows](research/windows-crt.md): why links with V8
  warn LNK4098 and the `crt-static` configuration that removes it.

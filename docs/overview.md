# Overview

fetchlet runs server-side JavaScript inside a Rust application. Rust hands a
Fetch handler a `Request` and receives its `Response`; named synchronous and
asynchronous functions are called through the same runtime. The engine is a
choice — QuickJS, Boa or V8 — and the Web APIs and polyfills that go into a
bundle follow that choice.

## Purpose

The main use is to embed the server side of a JavaScript web framework —
SvelteKit, Astro, Nuxt, React Router, HonoX and others — in a Rust program
that ships as one artifact, and so give it a rich web UI. Typical programs:

| Use                       | What the JavaScript side does                                                   |
| ------------------------- | ------------------------------------------------------------------------------- |
| Web UI bundled with a CLI | Pages and forms over the project, results and settings the CLI opened           |
| Local tools               | Search, logs, diffs, reports and settings over a local database or index        |
| Self-hosted applications  | Framework pages and Rust APIs that install and start as one program             |
| Desktop apps with Tauri   | The same server-side pages as the web version, backed by the app's Rust state   |
| Rendering plugins         | Dynamic pages or HTML fragments from JavaScript with narrowly granted authority |

Static SPA or SSG output can also be embedded in a single binary.
fetchlet adds the framework's server side — data loading, form actions,
dynamic rendering — so that the web version, the CLI UI and the desktop app
share pages and application logic. Separate Rust and Node services remain the
better fit when the two parts deploy and scale independently.

## Principles

**Easy.** One API covers engine selection, Web APIs, Request/Response
conversion, environment bindings, outbound fetch and Rust services. A bundle
includes only the polyfills and data its engine lacks, and keeps the engine's
native APIs.

**Secure.** Authority is granted explicitly, every host resource has an owner,
isolation follows the deployment, and tests and fuzzing check those
boundaries continuously. [Security](security.md) states what the current
boundaries enforce and what they leave to the host.

**Measured.** Compatibility claims name the dependency versions, profile and
inputs they were measured with. Results live in `results/` and are rendered
in [reference](reference/README.md).

## Design axes

Lifetime, isolation, authority and compatibility are independent choices.

| Axis          | Policy                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Lifetime      | Rust chooses per-call creation, a long-lived instance or reuse         |
| Isolation     | One application per tenant or authority configuration                  |
| Authority     | Network, services and environment values are granted explicitly        |
| Compatibility | A named Web API profile; Node APIs only where an adapter provides them |
| Engine        | Chosen independently of lifetime                                       |

Compiled code can be shared by code, engine version and profile; execution
state is reused only within one application, tenant and authority boundary.

## Scope

Today fetchlet runs trusted application code in-process. Deadlines and
busy and startup timeouts stop JavaScript that never yields on QuickJS and
V8, and on Boa at its next promise job or host call,
and request and response bodies stream in both directions.
QuickJS and V8 stop an instance at its heap limit. Process isolation is
planned work, listed in [open work](TODO.md). An investigation of
ahead-of-time compilation with Perry and scriptc is in
[research](research/native-aot.md).

## Where to go next

- [Domain model](domain-model.md): the types and who owns what.
- [Data flow](data-flow.md): how a build, a request and an outbound fetch move
  through the system.
- [Host services](host-services.md): bindings, console, outbound fetch and
  transports.
- [Embedding and distribution](embedding.md): single binaries, asset
  archives and Tauri.
- [The fetchlet npm package](../packages/fetchlet/README.md): the build
  tool and framework adapters.

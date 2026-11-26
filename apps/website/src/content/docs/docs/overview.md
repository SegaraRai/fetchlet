---
title: "Overview"
slug: docs/overview
description: "What fetchlet is for, how to choose an engine, and the design principles behind it."
---

fetchlet runs server-side JavaScript inside a Rust application. Rust passes a
standard `Request` to a JavaScript Fetch handler and receives its `Response`,
or calls exported synchronous and asynchronous functions directly through the
same runtime.

## When to use fetchlet

The primary use case is embedding the server side of a modern JavaScript web
framework — SvelteKit, Astro, Nuxt, React Router, TanStack Start, HonoX, and
others — inside a Rust program that ships as a single executable:

| Use case                 | What JavaScript handles                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| CLI with a web UI        | Interactive pages and forms over the local project, results, or settings      |
| Local developer tools    | Search, logs, diffs, reports, and dashboards over a local database or index   |
| Self-hosted applications | Framework SSR pages paired with Rust APIs, installed and run as one binary    |
| Desktop apps with Tauri  | The same server-rendered pages as your web app, backed directly by Rust state |
| Extensible rendering     | Dynamic pages or HTML fragments with explicit permissions and resource limits |

Static SPA or SSG builds can already be embedded in a Rust binary, but fetchlet
brings the framework's server side — data loaders, form actions, streaming SSR,
and server functions — so your web app, CLI UI, and desktop app can share the
same codebase.

When your Rust backend and JavaScript frontend need to deploy and scale
independently, running separate Rust and Node.js services remains the better
choice.

## Choosing an engine

fetchlet supports three JavaScript engines behind one API. All three share the
same [Web API profile](/docs/compatibility/web-api), so you can switch engines
without rewriting application code.

| Criterion             | QuickJS (`quickjs`, default)           | Boa (`boa`)                                              | V8 (`v8`)                                                |
| --------------------- | -------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Startup time          | Fast (tens of ms)                      | Slower                                                   | Moderate                                                 |
| Throughput under load | Moderate (interpreter)                 | Lower (interpreter)                                      | Highest (JIT)                                            |
| Build toolchain       | Requires a C compiler                  | Pure Rust (no C/C++)                                     | Prebuilt V8 binary (MSVC static CRT on Windows)          |
| WebAssembly           | Not available                          | Not available                                            | Native                                                   |
| Native `Intl`         | Polyfilled via FormatJS                | Polyfilled via FormatJS                                  | Native ICU                                               |
| Heap limit            | Enforced (`heap_bytes`)                | Not supported in-process                                 | Enforced (`heap_bytes`)                                  |
| Interrupting loops    | Preemptive (`timeout`, `busy_timeout`) | At promise jobs / host calls, or via `process` isolation | Preemptive (`reliable_termination` for allocating loops) |

**Rule of thumb:**

- Start with **QuickJS** for CLIs, desktop apps, and general self-hosted tools where fast startup and small binaries matter.
- Choose **V8** when you need high SSR throughput under concurrent load, native `Intl`, or libraries that require `WebAssembly` (such as `satori`, `resvg`, `shiki`, or `PGlite`).
- Choose **Boa** when you want a pure-Rust build with no C/C++ toolchain.

## Core design

- **Explicit permissions.** JavaScript has no access to the network, environment
  variables, or host resources unless Rust explicitly grants them through
  [`HostServices`](/docs/rust/host-services).
- **Caller-owned resource limits.** Timeouts, heap limits, body sizes, and
  subrequest counts live in Rust configuration
  ([Resource limits](/docs/rust/resource-policy)).
- **Independent axes.** Engine choice, instance lifetime (single instance vs.
  pooled), isolation mode (in-process vs. child process via the `process`
  feature), and permissions are configured independently.
- **Minimal polyfills.** `fetchlet/build` bundles only the polyfills your target
  engine lacks and keeps native engine APIs when available.

## Isolation modes

By default, fetchlet runs trusted application code in-process with explicit
permission policies and resource limits. When you need stronger isolation — or
hard memory and CPU termination on engines like Boa — enable the `process`
feature to run each JavaScript instance in a dedicated child process while
keeping host services and policies in the parent
([Process isolation](/docs/rust/fetchlet#process-isolation)). See
[Security](/docs/shipping/security) for the exact boundaries of each mode.

## Where to go next

- [Getting started](/docs): build and serve your first app.
- [Frameworks](/docs/frameworks): pick your framework adapter.
- [Serving over HTTP](/docs/rust/fetchlet-http): configure `Server`, routes, WebSockets, and Tauri webviews.
- [Host services](/docs/rust/host-services): expose environment values, Rust functions, and outbound fetch.
- [Embedding and distribution](/docs/shipping/embedding): bundle everything into one binary.

---
title: "Running JavaScript (fetchlet)"
slug: docs/rust/fetchlet
description: "Configure engines, worker pools, execution limits, and process isolation in the fetchlet crate."
---

The `fetchlet` crate embeds a JavaScript engine (QuickJS, Boa, or V8) in Rust.
Use it directly when calling JavaScript functions without HTTP, or when
configuring `AppBuilder` and `WorkerOptions` for custom servers.

```sh
cargo add fetchlet
```

## Engines and Cargo features

| Feature             | Adds                                                     |
| ------------------- | -------------------------------------------------------- |
| `quickjs` (default) | `Backend::quickjs()`, `Backend::QuickJs(QuickJsOptions)` |
| `boa`               | `Backend::boa()`, `Backend::Boa(BoaOptions)`             |
| `v8`                | `Backend::v8()`, `Backend::V8(V8Options)`                |
| `process`           | [Process isolation](#process-isolation) of each instance |

Multiple engine features can be enabled at once. `Backend::for_target(name)`
selects the engine recorded in `fetchlet.json` (`quickjs`, `boa`, `v8`, or
`portable`, which picks the first enabled engine). For choosing an engine, see
[Choosing an engine](/docs/overview#choosing-an-engine).

### Host Web API features

By default (`web-apis`), `fetchlet` includes Rust implementations for core Web
APIs shared across all three engines. You can opt into a smaller subset via
`default-features = false`:

| Feature              | Adds                                                    |
| -------------------- | ------------------------------------------------------- |
| `web-apis` (default) | All five below                                          |
| `url`                | `URL` parsing and setters in Rust (fallback: core-js)   |
| `url-pattern`        | `URLPattern`                                            |
| `compression`        | `CompressionStream`, `DecompressionStream`              |
| `web-crypto`         | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle` |
| `node-crypto`        | `node:crypto` hashes, HMAC, PBKDF2, HKDF, and scrypt    |

### Building with V8 on Windows (MSVC)

On Windows with MSVC, the `v8` feature links V8's prebuilt library, which uses
the static C runtime. Configure the static CRT in your binary's
`.cargo/config.toml` to avoid `LNK4098` warnings:

```toml
[target.'cfg(all(windows, target_env = "msvc"))']
rustflags = ["-C", "target-feature=+crt-static"]
```

## Worker pool and `AppHandle`

`AppBuilder::spawn(WorkerOptions)` runs the JavaScript runtime on dedicated
worker threads and returns a `Clone + Send + Sync` `AppHandle`:

```rust
use std::num::NonZeroUsize;
use fetchlet::{App, Backend, Module, WorkerOptions};

let options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
let app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .spawn(options)
    .await?;

let sum: i64 = app.call_json("add", &[20.into(), 22.into()]).await?.as_i64().unwrap();
let response = app.fetch(request).await?;
app.shutdown().await?;
```

- `call(export, &arg)` passes one Serde value and deserializes the return value.
- `call_json(export, &[...])` passes multiple JSON arguments.
- `fetch(request)` and `fetch_with_context(request, &ctx)` invoke the Fetch
  handler.
- `shutdown()` stops accepting new calls and waits for in-flight calls and
  `waitUntil` tasks to finish. Dropping the last `AppHandle` clone also shuts
  down the workers.

### Scaling instances

Each worker thread owns one engine instance and processes one call at a time
(concurrent requests on a single instance are currently blocked by QuickJS's
lack of async context propagation; see
[Async context](/docs/javascript/build#async-context)). Configure
`WorkerOptions::instances` to scale across multiple instances:

```rust
let mut options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
options.instances = Instances {
    min: NonZeroUsize::new(1).unwrap(),
    max: NonZeroUsize::new(4).unwrap(),
    idle_timeout: Some(Duration::from_secs(60)),
    max_held_connections: 0,
};
```

- The pool starts `min` instances, spawns additional ones up to `max` when all
  instances are busy, and retires idle instances above `min` after
  `idle_timeout`.
- Instances do not share JavaScript state; module-level globals exist once per
  instance, and each instance has its own heap.
- `max_held_connections` reserves a ceiling (strictly below `max`) for
  long-lived server WebSockets.
- Use `AppHandle::pool_state()` to inspect active/idle/building instances and
  queue depth for your own metrics or health checks:

```rust
let state = handle.pool_state();
if state.queued == state.queue_capacity && state.busy == state.max {
    // Pool is saturated; incoming callers are waiting for queue capacity.
}
```

### Cancellation and instance reuse

- After a normal call or a standard JavaScript exception, the instance is
  reused.
- Dropping a call's future cancels it. If an instance's state becomes uncertain
  (cancelled mid-execution, deadline exceeded, or returned with pending host
  fetches), the worker retires and rebuilds it before taking the next call.
- For development hosts where rebuilding an instance is slow (such as Vite dev),
  set `WorkerOptions::cancelled_calls` to `CancelledCalls::Finish` to let the
  in-progress evaluation finish within its deadline instead of retiring the
  instance.

## Timeouts, heap limits, and preemption

Configure execution limits on `Limits` ([Resource limits](/docs/rust/resource-policy)):

- **Timeouts:** `timeout` bounds an entire call (including streaming response
  bodies), `busy_timeout` bounds continuous JavaScript execution between event
  loop turns, and `startup_timeout` bounds initial module evaluation.
  - On QuickJS and V8, these interrupt non-yielding loops and retire the
    instance.
  - On Boa, timeouts are checked at promise jobs and host calls; use
    `BoaOptions::loop_iteration_limit` or [Process isolation](#process-isolation)
    to stop tight loops.
- **Heap limits:** `Limits::heap_bytes` bounds each instance's heap on QuickJS
  and V8 (minimum 16 MiB on V8; `V8Options::array_buffer_limit_bytes` bounds
  external `ArrayBuffer` memory and defaults to `heap_bytes`). Boa does not
  enforce in-process heap limits and refuses to build if `heap_bytes` is set
  (check with `Backend::bounds_heap`).
- **Preemption guarantee:** if you run untrusted code that must always be
  interruptible, require preemption on the module:
  `Module::new(source).requires(artifact.requirements().preemption())`. QuickJS
  satisfies this out of the box; V8 requires `V8Options::reliable_termination`
  (set on the first V8 isolate in the process so optimizing compilation stays on
  the isolate thread); Boa requires process isolation.

## Process isolation

Enable the `process` feature to run each instance's JavaScript engine in a
separate child process while keeping host services, policies, and the byte store
in the parent process:

```rust
use fetchlet::{App, Backend, Isolation, Module, ProcessOptions};

fn main() -> fetchlet::Result<()> {
    // Must be called at the start of main() when using Program::CurrentExe (default).
    fetchlet::serve_if_child();

    let app = App::builder(Backend::boa())
        .module(Module::new(bundle))
        .isolation(Isolation::Process(ProcessOptions::new()))
        .build()?;
    // ...
    Ok(())
}
```

- **Hard termination:** the parent terminates the child on `timeout`, past
  `busy_timeout` + `ProcessOptions::kill_grace`, or when a call is cancelled —
  satisfying `Requirements::preemption` on all engines, including Boa.
- **OS memory limits:** `ProcessOptions::memory_bytes` bounds child memory via a
  Windows Job Object, `RLIMIT_DATA` on Linux (note: V8 on x64 Linux reserves its
  code range and needs >512 MiB), or physical footprint sampling every 10 ms on
  macOS. Exceeding it fails with `LimitExceeded("process memory")`.
- **Crash containment:** if a child crashes or is terminated, the call fails
  with `Error::InstanceLost` and a pool automatically spawns a fresh child.
- By default (`Program::CurrentExe`), fetchlet re-executes your binary and
  `fetchlet::serve_if_child()` takes over immediately in `main()`. You can also
  point `Program::Path` at a separate helper binary built with the same engine
  features.

## Single-threaded `App`

If you want to manage threads yourself, `AppBuilder::build()` returns an owned
`App` whose methods take `&mut self` and execute serially on the calling thread.

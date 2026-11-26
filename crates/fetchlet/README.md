# fetchlet

Calls JavaScript functions and Fetch handlers from Rust. Requests,
responses and named functions share one runtime on QuickJS, Boa or V8.

| Feature             | Adds                                                     |
| ------------------- | -------------------------------------------------------- |
| `quickjs` (default) | `Backend::quickjs()`, `Backend::QuickJs(QuickJsOptions)` |
| `boa`               | `Backend::boa()`, `Backend::Boa(BoaOptions)`             |
| `v8`                | `Backend::v8()`, `Backend::V8(V8Options)`                |
| `process`           | [Process isolation](#process-isolation) of each instance |

Several engine features can be enabled together. Without any, the host API
(`HostServices`, `FetchService`, `Body`, `Limits`) remains available.

`Backend::for_target(name)` selects the engine an artifact was built for,
from the `backend` that `fetchlet/build` records: `quickjs`, `boa`, `v8`, or
`portable`, which takes the first enabled of QuickJS, Boa and V8. When that
engine's feature is not enabled, it fails with an error naming the feature.
`with_default_quickjs_stack` and `with_default_boa_stack` set an engine's
stack limits (for Boa, the value stack and recursion limit) when the options
leave them unset.

Every engine includes the host implementations of [fetchlet-web](../fetchlet-web/README.md).
These features select its Web APIs; the guest runtime installs only the
globals of the enabled ones. Without `url`, the guest's `URL` uses core-js's
parser instead of the `url` crate.

| Feature              | Adds                                                    |
| -------------------- | ------------------------------------------------------- |
| `web-apis` (default) | All four below                                          |
| `url`                | `URL` parsing and setters in Rust                       |
| `url-pattern`        | `URLPattern`                                            |
| `compression`        | `CompressionStream`, `DecompressionStream`              |
| `web-crypto`         | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle` |

On Windows with MSVC, `v8` links V8's prebuilt library, which is compiled
against the static C runtime. Build the binary with the static runtime as
well, so that it contains one C runtime instead of two, in the binary's
`.cargo/config.toml`:

```toml
[target.'cfg(all(windows, target_env = "msvc"))']
rustflags = ["-C", "target-feature=+crt-static"]
```

Without it, the link warns `LNK4098: defaultlib 'libcmt.lib' conflicts with
use of other libs`.

## Shared handle

`AppBuilder::spawn(WorkerOptions)` initializes the app on its own thread and
returns an `AppHandle`, which is `Clone + Send + Sync`.

```rust,ignore
use std::num::NonZeroUsize;
use fetchlet::{App, Backend, Module, WorkerOptions};

let options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
let app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .spawn(options)
    .await?;

let value = app.call_json("add", &[20.into(), 22.into()]).await?;
let response = app.fetch(request).await?;
app.shutdown().await?;
```

`queue_capacity` is the number of waiting commands; while the queue is full,
callers wait asynchronously. Each instance runs one call at a time on its own
worker thread. `WorkerOptions::instances` sets how many instances serve the
queue: one by default, or from `min` up to `max`, started on demand when
every instance is busy and retired after `idle_timeout`. Instances share no
JavaScript state; module-level state exists once per instance. The workers'
native stack size is set in `WorkerOptions` and defaults to the platform's.

```rust
let mut options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
options.instances = Instances {
    min: NonZeroUsize::new(1).unwrap(),
    max: NonZeroUsize::new(4).unwrap(),
    idle_timeout: Some(Duration::from_secs(60)),
    max_held_connections: 0,
};
```

`max_held_connections` bounds the instances that server WebSockets hold.
A handler that accepts an upgrade with `upgradeWebSocket` keeps its
invocation and instance until the connection closes, so the value must be
below `max`. The caller takes a place with `AppHandle::reserve_connection`
and puts the `HeldConnection` in the request's extensions; the 101 response
carries a `ServerWebSocket` extension whose `ChannelEnd` sends and receives
the socket's messages. fetchlet-http's `axum-websocket` feature does this for
axum.

`max` is a caller budget: each instance has its own engine heap. A host
fetch that calls its own app fails with `Reentrant` even when another
instance is idle.

`AppHandle::pool_state` reports what the pool is doing, for operators to
size it from their own load: instances building, idle, busy and retiring,
commands queued, connection places taken, the settings, and totals since
the spawn of builds, failed builds, build time, replaced instances, idle
retirements and refused connections. fetchlet exports no metrics itself;
read the state as often as a metrics system scrapes and record it there.

```rust
let state = handle.pool_state();
if state.queued == state.queue_capacity && state.busy == state.max {
    // Every instance is busy and the queue is full: requests now wait.
}
```

Dropping a call's future cancels that call. An instance retired by
cancellation, an expired deadline or unfinished work is rebuilt from the
same module, bindings and settings right after that call, before its worker
takes the next one. After an ordinary
JavaScript exception the state is reused. With
`WorkerOptions::cancelled_calls` set to `CancelledCalls::Finish`, the worker
instead lets a cancelled call's evaluation return within its deadline and
then cancels its body, keeping the instance; development hosts whose
instances are expensive to build use it.

`shutdown` stops accepting calls on every clone and waits for accepted calls
on every instance and their resources. Calls waiting for queue capacity receive
`WorkerClosed`. Dropping the last handle also ends the thread.

The `Limits::timeout` deadline counts from the start of execution.
`Limits::busy_timeout` bounds how long JavaScript runs before it returns to
the event loop, and `Limits::startup_timeout` bounds the module's
evaluation when an instance is built. On QuickJS and V8 they stop
JavaScript that never yields, fail with `DeadlineExceeded` (the deadline and
startup) or `LimitExceeded("engine busy time")`, and retire the instance.
Boa stops it at its next promise job or host call, and
`BoaOptions::loop_iteration_limit` stops a loop by count; other JavaScript
on Boa runs until it yields. A deadline that includes queueing can be
applied in Rust to the whole call future.

`Limits::heap_bytes` bounds an instance's heap on QuickJS and V8: reaching
it fails the call with `LimitExceeded("engine heap")` and retires the
instance. Boa has no heap limit, so an App on Boa with a heap budget fails
to build with `Error::Configuration` rather than run without it;
`Backend::bounds_heap` tells which engines enforce it.
`V8Options::array_buffer_limit_bytes` bounds `ArrayBuffer` storage, which
lives outside V8's heap, and defaults to the heap budget; past it,
JavaScript gets a `RangeError`. A heap budget below
`MIN_V8_HEAP_LIMIT_BYTES`, 16 MiB, is refused on V8, since V8 would end the
process while the isolate starts.

`Requirements::preemption` asks that the engine stop JavaScript that never
yields wherever it runs. QuickJS meets it, and V8 with
`V8Options::reliable_termination`; on Boa, or on V8 without the option, the
App fails to build and names the gap. An embedder that runs code it does
not trust adds it to the module's requirements:
`Module::new(source).requires(artifact.requirements().preemption())`.

V8 does not stop some hot loops that allocate, such as one around
`new Array(1000).fill(0)`, while it compiles their optimized code on a
background thread. `V8Options::reliable_termination` compiles that code on
the instance's thread instead, so the limits above stop every loop. It is
off by default, applies to the whole process, and must be set on the first
V8 instance the process starts.

## Process isolation

The `process` feature runs each instance's engine in a child process of
its own, while host services, policies and the byte store stay in the
parent (`AppBuilder::isolation`). The parent stops the child at the
invocation deadline, past `Limits::busy_timeout` plus
`ProcessOptions::kill_grace`, and when a call is dropped, on every engine,
so `Requirements::preemption` is met on Boa too.
`ProcessOptions::memory_bytes` bounds the child's memory, with a Job Object
on Windows and `RLIMIT_DATA` on Linux, and reaching it fails the call with
`LimitExceeded("process memory")`; other platforms refuse it. On x64
Linux, V8 reserves its code range within that limit and needs more than
512 MiB to start. `ProcessOptions::stack_bytes` sets the native stack of
the child's engine thread, which engine stack limits must fit. A child
that ends any other way fails the call with `Error::InstanceLost`. Every
stop retires the instance, and a pool replaces it.

```rust,ignore
use fetchlet::{App, Backend, Isolation, Module, ProcessOptions};

fn main() -> fetchlet::Result<()> {
    // Serves as the child when the parent started this executable as one.
    fetchlet::serve_if_child();
    let app = App::builder(Backend::boa())
        .module(Module::new(bundle))
        .isolation(Isolation::Process(ProcessOptions::new()))
        .build()?;
    // ...
    Ok(())
}
```

`Program::CurrentExe`, the default, starts the embedder's own executable,
which calls `serve_if_child` first thing in `main`; `Program::Path` names
another executable built with the same engine features. See [process
isolation](../../docs/research/process-isolation.md) for the design and
its costs.

`call` takes one Serde argument and `call_json` several JSON arguments.
`fetch_with_context` passes a per-request Serde value as the entry's second
argument.

## Owned app

`AppBuilder::build()` returns an `App` owned by the caller. Calls take
`&mut self` and run serially; use it to manage the thread and lifetime
yourself.

## Documentation

- [Domain model](../../docs/domain-model.md) and [data
  flow](../../docs/data-flow.md)
- [Host services](../../docs/host-services.md) and [resource
  policy](../../docs/resource-policy.md)
- [fetchlet-http](../fetchlet-http/README.md) for HTTP servers
- [Examples](../../examples/README.md)

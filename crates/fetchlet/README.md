# fetchlet

Calls JavaScript functions and Fetch handlers from Rust. Requests,
responses and named functions share one runtime on QuickJS, Boa or V8.

| Feature             | Adds                                                     |
| ------------------- | -------------------------------------------------------- |
| `quickjs` (default) | `Backend::quickjs()`, `Backend::QuickJs(QuickJsOptions)` |
| `boa`               | `Backend::boa()`, `Backend::Boa(BoaOptions)`             |
| `v8`                | `Backend::v8()`, `Backend::V8(V8Options)`                |

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

The `Limits::timeout` deadline is cooperative and counts from the start of
execution. A deadline that includes queueing can be applied in Rust to the
whole call future. Forcibly stopping JavaScript that never yields, or
initialization, is per-engine work ([open work](../../docs/TODO.md)).

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

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
callers wait asynchronously. Calls run serially within one app. The worker's
native stack size is set in `WorkerOptions` and defaults to the platform's.

Dropping a call's future cancels that call. An instance retired by
cancellation, an expired deadline or unfinished work is rebuilt from the
same module, bindings and settings before the next call. After an ordinary
JavaScript exception the state is reused.

`shutdown` stops accepting calls on every clone and waits for accepted calls
and their resources. Calls waiting for queue capacity receive
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

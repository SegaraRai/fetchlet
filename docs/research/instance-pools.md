# Research: instance pools

An `AppHandle` runs one instance on one worker thread, and that instance
evaluates one invocation at a time. Concurrent requests queue behind each
other. A streaming response body, `waitUntil` work or a slow host fetch
holds the only instance. This document designs pools of instances behind
one `AppHandle`. It covers the invariants they keep, scheduling, growth and
retirement, reentrancy, the instances that connections hold, and what waits
for async context on every engine.

## Invariants

A pool adds instances and keeps the invariants of a single instance:

- **One invocation per instance at a time.** An instance evaluates one call,
  one Fetch request, one response body pull or one background settle, as
  today. Host operations belong to the instance's only active invocation,
  which carries its `Context`, its budgets and its disconnect token. No
  async context is needed to attribute them.
- **One authority per pool.** Every instance of a pool is built from the same
  `AppBuilder`: the same module, `HostServices`, `Limits` and Fetch entry. The
  security rule stays the one in [Security](../security.md): one app per
  application, tenant and authority configuration. A pool never mixes
  configurations, so reusing any of its instances for any of its calls is
  as safe as reusing one instance is today.
- **No shared JavaScript state.** Instances share nothing in JavaScript.
  Module-level state, such as caches, counters or connection objects, exists
  once per instance and diverges between them. Applications that need state
  across requests keep it in the host, behind a service binding.
- **Retirement as today.** An instance whose state is uncertain retires:
  after a cancelled call under `CancelledCalls::Retire`, an exceeded deadline,
  pending host fetches at the end of a call, or unsettled background work. It
  affects only that instance's invocation.

Concurrent invocations inside one instance are a different design. They
need the request in an async context that every engine carries through
promise jobs, which QuickJS does not yet do
([async context](async-context.md)). They are out of scope until it does;
see [what waits for async context](#what-waits-for-async-context).

## Shape

The pool is the `AppHandle` itself. `WorkerOptions` gains the pool settings,
and the defaults keep one instance, so existing callers and fetchlet-http's
integrations keep their behavior:

```rust
let mut worker = WorkerOptions::new(queue_capacity);
worker.instances = Instances {
    min: 1,
    max: NonZeroUsize::new(4).unwrap(),
    idle_timeout: Some(Duration::from_secs(60)),
};
let app = App::builder(backend).module(module).host_services(services).spawn(worker).await?;
```

- Each instance runs on its own worker thread with its own current-thread
  Tokio runtime, as the single worker does today. Engines are thread-bound
  (V8 isolates, QuickJS runtimes and Boa contexts are used from one thread),
  and a thread per instance keeps each instance's event loop and timers
  independent.
- `AppHandle` keeps its API: `call`, `call_json`, `fetch`,
  `fetch_with_context` and `shutdown`. It stays `Clone + Send + Sync`.
- `queue_capacity` bounds the commands waiting for any instance. The queue
  is shared, not per instance, so a command never waits behind one busy
  instance while another is idle.
- `max` is a caller budget. Each instance holds its own heap, bounded by the
  engine options (`QuickJsOptions`, `BoaOptions`, `V8Options`), so `max` times
  that heap bounds the pool's JavaScript memory. The defaults keep
  `max = 1`; servers choose a larger value explicitly.

## Scheduling

- **First in, first out.** Commands are dispatched in arrival order to an
  idle instance. A command whose caller went away before it started is
  skipped, as today.
- **Growth.** When no instance is idle and fewer than `max` exist, the pool
  starts one. Building an instance evaluates the module, which takes from
  milliseconds to seconds depending on the application and engine. The
  waiting command goes to whichever comes first, the new instance or one
  that becomes idle, so a slow build never delays a command that an existing
  instance could take.
- **Builds off the request path.** The pool starts `min` instances at spawn
  and replaces retired instances in the background to keep `min`. A command
  waits for a build only when the pool grows past what is warm.
- **Shrinking.** An idle instance above `min` retires after `idle_timeout`.
  Retiring the most recently idle instance first keeps the warm instances'
  caches.
- **Background work.** An instance settles `waitUntil` work after its reply,
  before it takes the next command, as today. In a pool it is busy during
  that time, and other instances serve the queue.
- **Response bodies.** An open response body holds its instance until the
  body completes, fails or is cancelled. That no longer stops the
  application: other instances serve meanwhile.

## Held instances

Some work holds an instance beyond the call that started it:

| Holder                        | Released when                                             |
| ----------------------------- | --------------------------------------------------------- |
| An open response body         | The body completes, fails or is cancelled                 |
| Unsettled `waitUntil` work    | It settles or `background_timeout` passes                 |
| A server WebSocket connection | The connection closes ([host channels](host-channels.md)) |

Holding is ordinary for the first two, which are short. A connection can
last hours, so the pool bounds held connections with
`Instances::max_held_connections`, a caller budget with a default of 0. An
upgrade past the budget is refused before JavaScript runs. With
`max_held_connections < max`, connections cannot take every instance, and
requests keep at least `max - max_held_connections` instances.

## Reentrancy

A host fetch that calls the same application waits for that application. With
one instance, it waits for itself. With a pool, another instance could
serve it, but when every instance waits on such a call, none is left to
serve any of them.

- Calls made while a worker polls host futures of the same pool keep
  failing with `Error::Reentrant`. The pool's identity is the key the bridge
  already uses for the instances a worker rebuilds, shared by all instances
  of the pool ([in-process fetch](../in-process-fetch.md#reentrancy)).
- A later relaxation may accept a reentrant call when an idle instance
  exists, without waiting, and fail with `Error::Reentrant` otherwise. That
  needs a test that saturates the pool with reentrant calls and shows each
  one either served or refused.
- Calls from tasks that host futures spawn are not detected, as today. In a
  pool they wait for capacity and end at `Limits::timeout`. The test that
  saturates the pool covers this path too.

## Host transport tasks

Each instance's worker runs its own current-thread runtime. A task that a
host transport spawns there, such as the connection task of a pooled HTTP
client, makes progress only while that worker's engine yields. With several
workers, another instance that reuses the connection waits for the first
instance's evaluation to end
([tasks that host transports spawn](../TODO.md#tasks-that-host-transports-spawn)).

Pools make this common, so they come with a rule and a mechanism:

- `AppBuilder::host_runtime(Handle)` names the runtime for host transport
  tasks. fetchlet-http's servers pass the server's runtime.
- Each worker runs host futures with that handle available, so a transport
  that spawns uses the shared runtime instead of the worker's.
- A regression test reuses one HTTP connection from two instances while one
  of them evaluates a busy loop. The second instance's fetch must complete.

## Development

`DevReload` already builds a new `AppHandle` for each build and shuts the
old one down after its calls finish. A pool is one `AppHandle`, so this
changes nothing. Under `ViteDev`, each new instance fetches and evaluates
every module from Vite, so development pools default to one instance that
grows on demand. Caching the runner's transformed modules in Rust across
instances ([development reloads](../TODO.md#development-reloads-under-vitedev))
benefits a pool more than a single instance, because every new instance
pays that cost.

## Startup cost and shared code

Every instance evaluates the module from source. Engines can cache compiled
code: QuickJS bytecode and V8's code cache. A cache keyed by the module's
hash, the engine and its version, and the build profile would make growth
cheaper. It stays in the process and is built from the module the pool was
given, so it adds no input that the pool did not already trust. It is an
optimization after pools work. Measuring the build time of each example on
each engine first shows whether it matters ([measurements](../TODO.md#measurements)).

## What waits for async context

These need host operations attributed to one of several invocations
running at once in one instance. They are implemented once every engine
carries an async context through promise jobs and the adapters move to
`"propagated"`:

- concurrent Fetch invocations within one instance;
- several server WebSocket connections per instance;
- relaxing the one-invocation rule for long host waits, such as letting an
  instance take another request while its invocation awaits a host fetch.

## Verification

- Two slow Fetch requests on a pool of two finish in about the time of one.
  On a pool of one, they take the time of two.
- An open response body on one instance does not delay a request that
  another instance serves.
- A retired instance is replaced in the background. The next command does
  not wait for a build when `min` instances are warm.
- `idle_timeout` shrinks the pool to `min`. `max` and `queue_capacity` bound
  growth and waiting.
- Module-level state differs between instances, and each instance's state
  persists across its own calls.
- Reentrant calls under saturation are served or refused, never stuck past
  `Limits::timeout`.
- A connection reused across instances completes while one instance is busy.
- `max_held_connections` refuses upgrades past the budget before JavaScript
  runs.
- Every test runs on QuickJS, Boa and V8. The cancellation tests of a
  single worker run on a pool too.

## Order of work

1. Several instances behind `AppHandle` with the shared queue, `min`, `max`
   and `idle_timeout`, background replacement of retired instances, and the
   reentrancy key per pool.
2. `AppBuilder::host_runtime` and the cross-instance connection test.
3. Pool settings in fetchlet-http's server builders, with measurements
   that recommend defaults.
4. Held connections and `max_held_connections`, with
   [host channels](host-channels.md).
5. Compiled code caching, if the measurements show build time matters.

## Open questions

- Whether `App`, the single-threaded type, needs a pool too, or whether
  pools are only an `AppHandle` feature. Embedders that drive `App` on their
  own thread can build several `App`s already.
- How a pool reports its state, such as instances by state, queue length
  and rebuilds, for operators to size `max`.

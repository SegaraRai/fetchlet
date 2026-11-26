# Research: process isolation

fetchlet runs JavaScript in the embedder's process. Stopping JavaScript and
bounding its memory therefore depend on the engine
([interrupts and heap limits](interrupts-and-heap-limits.md)):

- Boa cannot stop JavaScript that never yields, and has no heap limit.
- V8 stops some allocating loops only with `reliable_termination`.
- A bug in any engine's native code, or an allocation larger than V8's
  unwinding headroom, takes the embedder's process with it.

`Requirements::preemption` and the Boa refusal of `Limits::heap_bytes` make
these gaps explicit at build time. They do not close them. This document
designs an isolation mode that runs each instance's engine in a child
process. The parent then enforces deadlines, cancellation and memory
budgets by killing the child or through OS limits, the same way on every
engine. Optionally, an OS sandbox removes the child's authority beyond its
connection to the parent.

Status: design. The first phase, measurement, is done on Windows
([Costs](#costs)), and the second, the `GuestLink` seam, is in place.
Process isolation itself is not implemented.

## Goals

- **Engine-independent enforcement.** The invocation deadline,
  `busy_timeout`, `startup_timeout`, a cancelled call and a memory budget
  stop an instance on Boa, QuickJS and V8 alike. Under isolation,
  `Requirements::preemption` is met on every engine.
- **Containment.** An engine crash, an abort or an out-of-memory error ends
  one instance, not the embedder. The pool replaces it, as it replaces a
  retired instance today.
- **No authority in the child.** Host services, policies, credentials,
  transports, bindings and `Functions` stay in the parent. A compromised
  engine can do only what the guest's host operations already allow.
- **The same API.** The Request → Response API, generic function calls,
  pools, streaming bodies, channels and background work behave as they do
  in-process. Isolation is one setting, independent of the engine choice.

Non-goals: isolating tenants from one another inside one pool (one app per
authority configuration remains the rule), and isolating the embedder from
its own host services.

## Where the boundary goes

There are two candidate cuts.

**Around the whole App, at the `AppHandle` command queue.** The child runs
the worker, the bridge and the host services. Host services are Rust
values the embedder built (closures, transports, routers), so the child
would have to rebuild them by running the embedder's own setup code. The
child would also hold the network and every credential, so a sandbox could
not take them away. This cut contains crashes but leaves the child's
authority equal to the parent's.

**Around the engine, at the bridge.** An engine reaches the host through a
narrow surface of `HostBridge`:

- `dispatch(operation, input) -> String`: every host operation, as a name
  and a JSON message;
- `put_guest_bytes` and `take_guest_bytes`: the invocation's byte store;
- `wake_signal`: the notification the engine waits on between host steps.

Everything else stays in the parent:

- the invocation lifecycle (`begin`, `open_body`, upgrades, channels,
  disconnects), which `App` calls;
- the deadlines;
- the wire encoding of requests and responses;
- response streaming.

The `Engine` enum's interface is just as small: `new`,
`evaluate(expression, deadline)`, `call_json` and `is_reusable`.

This design takes the second cut. The child holds an engine, the module
and a proxy of the bridge surface. The parent keeps `App`, `HostBridge` and
every service, and drives the child through a remote `Engine`. Under this
cut:

- host operations reach the same dispatcher, with the same checks and the
  same fuzzing, as they do in-process;
- the child needs no network and no file system, so a sandbox can remove
  them;
- pools, retirement and body streaming need no change, because they sit
  above `Engine`.

```text
parent process                                   child process
─────────────────────────────────────────────    ──────────────────────────
AppHandle → worker → App ─ Invocation             engine (Boa/QuickJS/V8)
                      │                             │ host functions
                      ▼                             ▼
                 Engine::Process ◀═══ frames ═══▶ GuestLink::Remote
                      │  evaluate / reply           dispatch, bytes, wake
                      ▼
                 HostBridge ─ HostServices
                 (policy, transports, Functions, byte store, tickets)
```

## Configuration

Isolation is an `AppBuilder` setting, not a `Backend` variant. The engine
choice (`Backend`) and where the engine runs are independent design
parameters:

```rust
App::builder(Backend::boa())
    .module(module)
    .isolation(Isolation::Process(ProcessOptions {
        program: Program::CurrentExe,
        memory_bytes: Some(256 << 20),
        kill_grace: Duration::from_millis(100),
        sandbox: Sandbox::None,
    }))
    .spawn(workers)
    .await?;
```

| Setting                        | Owner and rationale                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Isolation::InProcess`         | The default; today's behavior                                                                                                                                                               |
| `ProcessOptions::program`      | The caller: `CurrentExe` re-runs the embedder's binary in child mode; `Path` names a separate executable built with the same engine features                                                |
| `ProcessOptions::memory_bytes` | Caller budget for the whole child (engine heap, code, stacks), enforced by the OS: a Job Object on Windows, cgroup v2 `memory.max` or `RLIMIT_AS` on Unix                                   |
| `ProcessOptions::kill_grace`   | Caller policy: how long past a deadline the parent waits for the engine's own interrupt before it kills the child. The engine's interrupt keeps the error precise; the kill is the backstop |
| `ProcessOptions::sandbox`      | Caller policy: `None`, or an OS profile ([Sandboxing](#sandboxing))                                                                                                                         |

`Limits` keeps its meaning: `heap_bytes` still maps to the engine's own
limit where the engine has one, and remains refused on Boa. `memory_bytes`
is the process budget that every engine can have. `Backend::preemption()`
and `static_unmet` take the isolation into account. Under
`Isolation::Process` the preemption requirement is met on every engine,
because the parent can always kill the child.

### Starting the child

With `Program::CurrentExe` the embedder calls
`fetchlet::process::serve_if_child()` first thing in `main`. When the
process was started as a fetchlet child (an argument and an inherited
handle mark it), the call serves the parent and never returns. Otherwise it
returns at once. This keeps one binary to deploy, which a desktop app such
as the Tauri example needs. `Program::Path` suits deployments that ship a
dedicated, smaller engine executable. Test binaries use a `harness = false`
integration test whose `main` calls `serve_if_child` before running the
tests.

The child receives its configuration over the connection, not on the
command line:

- the `Backend` options (serializable behind the `process` feature);
- the module source and name;
- the requirements to probe;
- the `Limits` that the engine applies itself.

It builds the engine with a remote `GuestLink` and reports the probe
result, so `AppBuilder::build` fails the same way it does in-process.

## The connection

The connection uses the child's standard input and output, inherited
anonymous pipes on every platform. Nothing is named or listening, so the
sandbox can deny every other channel. Standard error carries the engine's
own diagnostics, which the parent forwards to its log.

Frames carry a header and a payload: a kind, a request id, and a payload
length bounded by the largest bridge message the limits allow. Payloads are
JSON for operations and replies, and raw bytes for the byte store.

| Direction      | Frame                   | Meaning                                                                |
| -------------- | ----------------------- | ---------------------------------------------------------------------- |
| parent → child | `Init`                  | Backend options, module, requirements, engine limits                   |
| child → parent | `Ready` / `Failed`      | The probe result, or the build error                                   |
| parent → child | `Evaluate`, `CallJson`  | One evaluation, with its deadline for the engine's own interrupt       |
| child → parent | `Result`                | The value, an interrupt, or a JavaScript error; `reusable` flag        |
| child → parent | `Dispatch`              | A host operation; the engine thread blocks until the reply             |
| parent → child | `Reply`                 | The dispatcher's JSON reply                                            |
| child → parent | `PutBytes`, `TakeBytes` | The byte store, which lives in the parent's invocation                 |
| parent → child | `Wake`                  | The parent's `WakeSignal` fired: a transport, channel or body is ready |

The child runs a reader thread that routes replies to the waiting engine
call and turns `Wake` into a notification of its local `WakeSignal`, so the
engine's event loop waits as it does in-process. Host operations remain
synchronous for the engine; async work still goes through tickets and
`host.poll`.

Everything the child sends is untrusted, as guest input is today. The
parent decodes frames within the size bound and hands operations to the
same `HostBridge` that the bridge fuzzer already covers. A new fuzz target
mutates the frame stream against the parent's decoder and checks that:

- no frame reaches the bridge outside an evaluation;
- every request id is answered at most once;
- a malformed or oversized frame ends the child, not the parent.

## Enforcement

- **Deadline and `busy_timeout`.** The parent arms the same timer it arms
  today. The child's engine gets the deadline too, so QuickJS and V8 stop
  with a precise `Interrupted`. When the timer passes and `kill_grace`
  passes with no `Result` frame, the parent kills the child and reports
  `DeadlineExceeded`. On Boa the kill is the only stop for code that never
  yields.
- **`startup_timeout`.** It works the same way around `Init` → `Ready`.
- **Cancellation.** Under `CancelledCalls::Retire`, dropping the call kills
  the child at once. Under `Finish`, the parent waits within the deadline,
  as today.
- **Memory.** The OS limit ends the child at `memory_bytes`. The parent
  reads why the child ended:
  - Windows: the Job Object's `JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT`;
  - Linux: the cgroup's `memory.events` `oom_kill`, or the allocation
    failure that `RLIMIT_AS` causes;
  - It reports `LimitExceeded("process memory")`.

  The engine's own `heap_bytes` still stops the instance earlier with
  `LimitExceeded("engine heap")` where it applies.

- **Crashes.** Any other end of the child reports a new
  `Error::InstanceLost`, with the exit status and the tail of standard
  error, and retires the instance. The pool builds a replacement as it does
  for any retirement.

Every stop retires the instance, as in-process stops do. A child is never
reused after a kill, so its state never needs repair.

## Sandboxing

The process boundary alone contains crashes and makes enforcement
engine-independent. A sandbox profile also removes the child's authority,
so native code run through an engine bug can reach only the connection to
the parent:

| Platform | Profile                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | New user and network namespaces with no interfaces, Landlock with no file access after start, seccomp-bpf allowing memory, threads, futex, time and the two pipes |
| Windows  | A Job Object with kill-on-close, one active process and UI restrictions, and an AppContainer or restricted low-integrity token with no capabilities               |
| macOS    | `sandbox_init` with a deny-default profile; the API is deprecated but still what Chromium uses                                                                    |

The engine loads everything it needs before the sandbox closes: V8's
snapshot and ICU data, and QuickJS and Boa's statically linked code. After
`Ready`, the child needs only memory, threads, clocks and its pipes. Tests
assert on each platform that the child can open neither a file nor a
socket.

## Costs

Each crossing of the connection costs a round trip: a host operation, an
evaluation the parent starts, or a transfer through the byte store. Two
tools in `tools/bench` measure what that adds
([its README](../../tools/bench/README.md#process-isolation)).

### Crossings per request

`host-operations` counts the crossings of each request to the bench
endpoints, after two unmeasured requests. It uses the artifacts of
`vp run bench` and fetchlet's hidden `operation-counts` feature. The counts
are the same on QuickJS, Boa and V8. Server-rendered pages make 9 to 33
crossings and carry 1.5 to 15 KB in all. The JSON endpoints make 3 to 30.

| Application    | Page | of them URL | JSON endpoint |
| -------------- | ---: | ----------: | ------------: |
| bare           |   10 |           3 |             4 |
| HonoX          |    9 |           2 |             3 |
| SvelteKit      |   13 |           5 |             5 |
| TanStack Start |   12 |           4 |             5 |
| SolidStart     |   15 |           8 |             5 |
| Nuxt           |   17 |           7 |             5 |
| Waku           |   21 |           6 |            11 |
| Astro          |   23 |          13 |             8 |
| Qwik City      |   28 |          15 |             7 |
| React Router   |   32 |          24 |            18 |
| vinext         |   33 |          20 |            29 |

Each page makes five crossings that need the parent:

- the evaluation;
- one `bytes.put` and one `bytes.take`;
- `fetch.start` and `host.poll` for the call to the RUST service.

Everything else carries no authority:

- `url.parse` and `url.set`, which are most of the rest;
- `clock`, `crypto.random` and `fetch.limits`;
- `invocation.disconnected`, which the parent can push to the child
  instead of being asked.

No page waited on a wake: the service answers within the poll.

### Round trips and process starts

`ipc` measured on Windows 11 with a 16-thread desktop CPU, in a release
build:

| Frame, request → reply | Blocking parent, p50 / p99 | tokio parent, p50 / p99 |
| ---------------------- | -------------------------: | ----------------------: |
| 64 B → 64 B            |             13.1 / 34.4 µs |          27.2 / 69.0 µs |
| 256 B → 1 KiB          |             12.8 / 34.2 µs |          26.4 / 57.1 µs |
| 64 B → 16 KiB          |             15.4 / 36.3 µs |          29.6 / 56.6 µs |
| 64 KiB → 64 B          |             35.5 / 49.8 µs |         42.1 / 105.5 µs |

Starting a child and reading its first byte takes:

- 4.3 ms at p50 for a 0.8 MB binary;
- 7.3 ms at p50 for the 69 MB `host-operations` binary, which links all
  three engines as an embedder's binary would.

Against the 25 to 140 ms an engine needs to start
([startup and memory](startup-and-memory.md)), the process start is
small. Linux remains to be measured.

### What it adds to a page

Alone, a page takes 0.35 to 2.98 ms at p50 on V8, and more on QuickJS and
Boa ([startup and memory](startup-and-memory.md#latency)). If every
crossing goes to the parent, the round trips add 0.12 to 0.43 ms per page
with a blocking parent, or 0.24 to 0.89 ms with tokio's pipes. That is
10 to 38 % of the page on V8, and up to 80 % with tokio. If the child
serves the crossings that carry no authority itself, five remain on every
page. They add 0.07 ms with a blocking parent and 0.14 ms with tokio:

- 2 to 10 % on V8 for the framework pages;
- 16 to 19 % for the smallest pages, bare and HonoX;
- less on QuickJS and Boa, whose pages take longer.

This leads to three decisions for the implementation:

- **The child serves operations that carry no authority.** It runs
  fetchlet-web's stateless operations (URL parsing, URL patterns,
  `crypto.random`, digests and other crypto) with the same crate and
  `WebLimits`. It also keeps its own clock, receives `fetch.limits` with
  the evaluation, and is told about a disconnect instead of being asked.
  Compression, which keeps per-invocation state, stays in the parent.
  This is part of phase 3, not a later optimization.
- **The parent's end of each child blocks on a thread of its own.** It
  answers the child's host calls from that thread. It talks to the async
  worker only for evaluations and wakes, which halves the round trip
  against tokio's pipes.
- **Bytes go in the frames.** An evaluation's result can carry the bytes
  the engine put, and a reply the bytes it takes. This saves the two
  byte-store round trips per page. Shared memory is not needed at these
  sizes: a 64 KiB frame takes 36 µs.

These measures reduce the cost further:

- **Batched polls.** `host.poll` already returns every ready completion at
  once.
- **Warm processes.** A pool's `min` keeps built children. V8's code cache
  is produced in the child and can be returned to the parent for the next
  child.

One child per instance keeps the kill granular to one invocation. A child
holding several instances would save memory but make a kill end unrelated
work, so this design does not offer it.

## Implementation phases

1. **Measurement.** Done on Windows ([Costs](#costs)). Linux remains to
   be measured with the same tools before phase 3 settles the parent's
   threading.
2. **The `GuestLink` seam.** Done. Engines take a `GuestLink`
   (`crates/fetchlet/src/bridge/guest_link.rs`) in place of `HostBridge`:
   host operations, the byte store and the wake signal, and nothing else
   of the bridge. Its only variant is `Local(HostBridge)`, so behavior is
   unchanged; phase 3 adds `Remote`.
3. **Process isolation.** Add the `process` feature, `Isolation`,
   `ProcessOptions`, the frame codec, `serve_if_child`, the remote `Engine`,
   the kill timer, the OS memory limits and `Error::InstanceLost`. The
   child also serves the operations that carry no authority, and frames
   carry bytes ([Costs](#costs)). Tests on
   each engine:
   - Boa recursion that never yields stops at the deadline;
   - `Requirements::preemption` is met on Boa;
   - a memory bomb ends with `LimitExceeded("process memory")`;
   - an abort in the child leaves the parent serving;
   - a dropped call kills the child;
   - the pool replaces a lost instance;
   - streaming bodies and channels work across the boundary;
   - the frame fuzz target runs.
4. **Sandbox profiles.** Linux and Windows first, each with tests that file
   and socket access fail in the child, then macOS.
5. **Cost reductions.** Returning V8's code cache to the parent, and
   whatever a profile of the isolated examples shows.

The phases change the published crates as follows, each with a changeset:

- `fetchlet`: `AppBuilder::isolation`, `Isolation`, `ProcessOptions`,
  `serve_if_child` and `Error::InstanceLost`;
- `fetchlet-http`: an isolation setting on `Server`.

## Effect on the design matrix

In-process, the stop and budget requirements depend on the engine:

- FR5 (stop and cancel) ← DP2 (engine)
- FR7 (budgets) ← DP2 (engine)

Under `Isolation::Process`, the parent's kill timer and the OS memory limit
satisfy them, and neither depends on which engine runs in the child. The
engine's own interrupt and heap limit remain as refinements that give more
precise errors. They are no longer what makes the guarantee hold. The
in-process mode keeps the build-time checks that B1 introduced.

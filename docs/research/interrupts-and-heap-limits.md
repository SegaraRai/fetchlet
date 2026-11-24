# Research: stopping JavaScript that never yields, and heap limits

The invocation deadline stops JavaScript that never yields on QuickJS and
V8, and retires the instance. On Boa it is still cooperative: a timer fires
only once JavaScript returns to the event loop, so a script that loops
without awaiting holds the instance, and the thread under it, for as long
as the loop runs. Only QuickJS has a heap limit, and it reports exhaustion
as an exception that reads `Null"null"`. This document records what each
engine provides, as of the versions in `Cargo.lock`, and designs
enforcement on top of it: stopping non-yielding JavaScript at the
invocation deadline, during initialization and after a busy budget, and
bounding each instance's heap.

## Status

| Engine         | Non-yielding JavaScript                                                                                                                                                                                       | Heap                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| QuickJS (0.14) | Stopped at the deadline. Each evaluation arms the instance's `Interrupt`, which the interrupt handler and the job loop check; the evaluation fails with `DeadlineExceeded` and the instance retires.          | `QuickJsOptions::memory_limit_bytes` sets `JS_SetMemoryLimit`. Exhaustion surfaces as an unnamed error. |
| Boa (0.22)     | Runs on the calling task's thread, so `with_deadline` cannot fire while it runs. `run_jobs` drains the whole job queue, so a microtask chain that keeps queueing never returns to fetchlet's loop.            | None.                                                                                                   |
| V8 (deno_core) | Stopped at the deadline. V8 runs on its own thread; when the caller drops the evaluation, `Cancellation` calls `IsolateHandle::terminate_execution`, and the instance retires. Initialization is not covered. | None. Exhaustion aborts the process with V8's fatal out-of-memory error.                                |

`crates/fetchlet/tests/interrupts.rs` stops, on QuickJS and V8, a loop, a
loop inside `try`/`catch`, a loop in a promise reaction, an endless
microtask chain, regular expression backtracking and exponential recursion,
each within the deadline plus scheduling slack, and checks that the
instance retires and that a pool replaces it.
`crates/fetchlet/tests/host_runtime.rs` shows the Boa case from the
outside: while one instance runs a bounded busy loop, a host fetch that
needs that instance's runtime waits for the loop to end.

Initialization (the module's top-level code, run by `AppBuilder::build` and
by each new pool instance) has no deadline on any engine.

## What each engine provides

### QuickJS

rquickjs 0.14 bundles QuickJS-ng 0.16.2.

- **Interrupts.** `Runtime::set_interrupt_handler(Box<dyn FnMut() -> bool +
  Send>)` installs `JS_SetInterruptHandler`. The interpreter calls the
  handler once every 10,000 polls (`JS_INTERRUPT_COUNTER_INIT`). It polls at
  function calls, at backward jumps, and inside the regular expression
  engine. When the handler returns `true`, QuickJS throws `InternalError:
  interrupted` and marks it uncatchable (`JS_SetUncatchableError`), so
  `try`/`catch` and promise handlers cannot swallow it. The handler runs on
  the engine's thread, so it can check a clock or an atomic flag; no other
  thread is involved.
- **Heap.** `set_memory_limit` caps `malloc_size`, which counts every
  allocation QuickJS makes, `ArrayBuffer` storage included. When an
  allocation fails, QuickJS throws `InternalError: out of memory`. That
  error is catchable. When the error object itself cannot be allocated, the
  exception is `null`, which is the `Null"null"` that fetchlet reports
  today. `Runtime::memory_usage()` reads the counters.
  `Runtime::new_with_alloc` takes a custom `Allocator`, which can count
  allocations itself and record which one failed. With the `allocator` or
  `rust-alloc` feature, `set_memory_limit` does nothing.

### Boa

- **Interrupts.** Boa 0.22 has no hook that another thread or a clock can
  use to stop the VM. A question about time limits was answered that Boa
  does not provide them
  ([boa-dev/boa#3238](https://github.com/boa-dev/boa/discussions/3238)).
  What it has:
  - `RuntimeLimits::set_loop_iteration_limit`. `IncrementLoopIteration`
    counts the loop iterations of each call frame and throws
    `RuntimeLimitError::LoopIteration` past the limit. The limit counts
    iterations, not time.
  - `RuntimeLimitError` converts into an `EngineError`, which
    `JsError::is_catchable` reports as uncatchable. Host code can raise one
    too: `JsError::from(RuntimeLimitError::LoopIteration)` from a native
    function or a host hook stops the script the way an engine limit does.
  - fetchlet already implements `HostHooks::call_job_callback`, which Boa
    calls for every promise reaction, and native functions for the bridge.
    Both run between pieces of JavaScript.
  - `Script::evaluate_async_with_budget` yields every so many
    instructions, but only in the frames that its own loop runs. Callbacks
    that natives invoke, including promise jobs, run on the synchronous
    path, which is where invocations spend their time.
  - The instruction budget (`ContextBuilder::instructions_remaining`)
    exists only with the `fuzz` feature and cannot be refilled.
- **Heap.** boa_gc keeps thread-local counters of the bytes it has
  allocated and uses them to time collections. They are not public, and
  they leave out the buffers that objects own outside their `GcBox`, such
  as strings and array storage. Boa has no allocation limit.

### V8

- **Interrupts.** `IsolateHandle::terminate_execution` works from any thread
  and unwinds JavaScript with an uncatchable termination.
  `cancel_terminate_execution` makes an isolate usable again, but fetchlet
  retires a terminated instance instead, because its JavaScript state is
  unknown. `request_interrupt` runs a callback on the isolate's thread.
- **Heap.** `v8::CreateParams::heap_limits(initial, max)`, passed through
  `RuntimeOptions::create_params`, caps the managed heap.
  `JsRuntime::add_near_heap_limit_callback(|current, initial| new_limit)`
  runs just before V8 would fail. The callback can call
  `terminate_execution` and raise the limit enough for the termination to
  unwind, which stops the isolate without crashing the process. A single allocation larger than the extra room is still a
  fatal error. `ArrayBuffer` backing stores live outside the managed heap.
  An array buffer allocator set in `CreateParams` can count them, and when
  it refuses one, JavaScript sees a catchable `RangeError`.

## Design

### Goals and owners

1. **The invocation deadline stops JavaScript.** `Limits::timeout`,
   `background_timeout` and the deadline of a response body already exist.
   This work makes them hold whether or not JavaScript yields.
2. **A busy budget.** `Limits::busy_timeout: Option<Duration>` bounds how
   long JavaScript may run before it returns to the event loop, counted
   from each entry into the engine. It protects invocations that have no
   deadline, connections held for their lifetime, and the worker's other
   work. It is a caller policy, and like every `Limits` field it defaults
   to `None`. fetchlet-http's `Server` sets it.
3. **A startup deadline.** `Limits::startup_timeout: Option<Duration>`
   bounds the evaluation of the module when an instance is built. It is a
   caller policy and defaults to `None`.
4. **A heap limit on each engine that can enforce one.** A caller policy in
   each engine's options, as `memory_limit_bytes` is today, so that a
   pool's `max` times the limit bounds its JavaScript memory.

Every stop retires the instance. A stopped script leaves module state,
open bodies and host operations in an unknown state, as a dropped call
does today. The invocation scope's cleanup releases the host's side.

These limits use wall-clock time, as the existing deadlines do. Per-thread
CPU time would not count time spent waiting for a busy host. Measuring it
costs a system call, and V8's thread would need its own clock. CPU time can
be added later as a separate budget if a deployment needs it.

### One interrupt per instance

Each instance gets a crate-internal `Interrupt`, shared between the
instance's thread and anything that may stop it:

```rust
pub(crate) struct Interrupt {
    /// When the current entry must stop: the earlier of the invocation
    /// deadline and the entry's start plus `busy_timeout`, as nanoseconds
    /// since a process-wide base instant; 0 when nothing is armed.
    deadline: AtomicU64,
    /// Why the engine was stopped, once it has been: none, deadline, busy,
    /// heap or cancelled.
    reason: AtomicU8,
}
```

- `arm(deadline)` at each entry into JavaScript: the evaluation of an
  invocation expression, each loop step, each job batch, and module
  evaluation at startup.
- `disarm()` when control returns to fetchlet's loop.
- `stop(reason)` from any thread, for cancellation and for the heap
  callbacks.
- `expired(now)` records the reason and returns `true`.

An engine error is classified by the recorded reason, not by its message:
`Error::DeadlineExceeded` for the deadline and for startup,
`Error::LimitExceeded("engine busy time")` for the busy budget, and
`Error::LimitExceeded("engine heap")` for the heap. A stop whose reason is
recorded always retires the instance, even when JavaScript caught the error
(QuickJS's out-of-memory error is catchable).

### Stopping on each engine

**QuickJS** (implemented for the invocation deadline). The interrupt
handler returns `interrupt.expired()`, which reads the clock only while an
evaluation is armed. Reading it every 10,000 polls costs little next to the
interpreter, and no watchdog thread is needed. The handler covers loops,
recursion, regular expressions, promise jobs and module evaluation, because
all of them run through the interpreter. `Ctx::execute_pending_job`
discards the exception of a job that threw, the interrupt's included, so
fetchlet drives the job queue itself and checks the interrupt between jobs.
Long native built-ins with no polls inside, such as joining a huge array,
are bounded by the heap limit.

**V8.** The invocation deadline already works, because the caller's timer
drops the evaluation and `Cancellation` terminates the isolate. Two
additions:

- **Busy budget.** One process-wide watchdog thread, started lazily, keeps a
  list of the armed `Interrupt`s of V8 instances with their isolate handles.
  It wakes at the earliest armed deadline, or when a shorter one is armed,
  and calls `terminate_execution` on each expired instance. Arming and
  disarming are atomic stores, plus a notification only when the new
  deadline is earlier than the one the watchdog sleeps toward.
- **Startup.** `V8::with_host` waits on `initialized.recv()` with no limit.
  The worker sends the isolate handle before it evaluates the module, and
  the creator waits with `recv_timeout`, terminating the isolate when the
  wait expires.

**Boa.** Boa cannot be stopped from outside, so the design does what Boa
allows and states the gap:

- **Checks between pieces of JavaScript.** `call_job_callback`, the bridge's
  native functions and the loop step check `interrupt.expired(now)`. On
  expiry they return `JsError::from(RuntimeLimitError::LoopIteration)`,
  which JavaScript cannot catch, and the instance retires. This stops
  microtask chains and scripts that call the host in a loop.
- **Loop iteration limit.** A new `BoaOptions::loop_iteration_limit`, owned
  by the caller, applies `set_loop_iteration_limit`. It caps the work of a
  single frame by count rather than time. fetchlet-http sets a value
  measured against the examples' rendering, with a large margin.
- **Remaining gap.** JavaScript that runs no loop, makes no host call and
  queues no job can still run without bound. Exponential recursion within
  the recursion limit is the example. `crates/fetchlet/tests` records this
  case as a known limitation on Boa. A real fix needs an interrupt poll in
  Boa's VM, at the same places QuickJS polls (backward jumps and calls),
  which reads a host-provided `Arc<AtomicBool>` or callback. The plan is to
  propose that upstream, and to carry it as a `[patch]` only if a
  deployment needs the guarantee before a release ships it. Until then, the
  documentation directs untrusted code to QuickJS or V8, or to a process
  boundary.

Detaching Boa's thread and leaving it to spin was considered and rejected.
The thread would keep its CPU and memory indefinitely, and the same
discussion notes that ending it would not free the GC heap. The process has to restart
to recover either way.

### Heap limits

**QuickJS.** Replace `set_memory_limit` with an `Allocator` passed to
`Runtime::new_with_alloc`. The allocator counts bytes against
`memory_limit_bytes` and refuses allocations past it. On the first refusal
it calls `interrupt.stop(Heap)`. Then:

- the failure is named precisely, whatever exception QuickJS manages to
  build, which fixes the `Null"null"` report;
- the next interrupt poll stops JavaScript that caught the error and
  carried on;
- the instance retires after the invocation.

The allocator is a thin counter over the system allocator. Its cost is
measured against `set_memory_limit` with the examples before it replaces
it. If the cost shows, the fallback keeps `set_memory_limit` and classifies
an error as heap exhaustion when `memory_usage().malloc_size` is within one
allocation of the limit.

**V8.** A new `V8Options::heap_limit_bytes` passes
`heap_limits(initial, max)` through `create_params`. A near-heap-limit
callback calls `interrupt.stop(Heap)` and `terminate_execution`, and
returns the current limit plus headroom (a quarter of the limit, at least
8 MiB) so that termination can unwind. The instance retires. An array
buffer allocator counts backing stores against a separate
`V8Options::array_buffer_limit_bytes`, which defaults to the heap limit and
refuses with a `RangeError`. These budgets have precise limits:

- A single allocation larger than the headroom, such as one enormous
  string, can still end the process with V8's fatal out-of-memory error.
- The headroom is extra memory each instance may briefly use; a pool's
  bound is `max` times the limit plus the headroom.

**Boa.** No limit in this phase. A process-wide counting allocator was
considered. It would be installed by the embedder as `#[global_allocator]`
and charge allocations to the instance on the current thread, which works
because each pool instance owns one thread. It was not chosen for three
reasons:

- It can only be soft. Refusing an allocation aborts Rust, so the counter
  could only set a flag that a later check reads.
- Memory freed on another thread is charged to the wrong instance.
- It would impose a global allocator on the embedding application.

Boa deployments that need a memory bound rely on the process boundary.

### Configuration

| Setting                               | Owner  | Default        | fetchlet-http `Server`                           |
| ------------------------------------- | ------ | -------------- | ------------------------------------------------ |
| `Limits::busy_timeout`                | Caller | `None`         | Measured; seconds, not milliseconds              |
| `Limits::startup_timeout`             | Caller | `None`         | Measured from the slowest example's startup      |
| `QuickJsOptions::memory_limit_bytes`  | Caller | `None`         | 64 MiB, as today                                 |
| `V8Options::heap_limit_bytes`         | Caller | `None`         | From [startup and memory](startup-and-memory.md) |
| `V8Options::array_buffer_limit_bytes` | Caller | The heap limit | The heap limit                                   |
| `BoaOptions::loop_iteration_limit`    | Caller | `None`         | Measured, with a large margin                    |

`Backend::with_default_*` helpers set the engine values where the caller
has not, as they do for stacks and the QuickJS heap today.

## Tests

Each test runs on every engine and expects the same outcome. The Boa cases
listed under its remaining gap are the only exception.

- `while (true) {}` in a call with a 200 ms timeout fails with
  `DeadlineExceeded` within the timeout plus scheduling slack, and the
  instance retires. In a pool, the next call gets a fresh instance.
- The same loop inside `try`/`catch` and inside a promise reaction is not
  caught.
- `function f() { queueMicrotask(f) } f()` stops at the deadline.
- With no timeout and `busy_timeout` set, a busy loop fails with
  `LimitExceeded("engine busy time")`. A call that yields often and
  outlasts `busy_timeout` in total succeeds.
- A busy loop in a held connection's message handler stops after
  `busy_timeout`.
- A busy loop at module top level makes `build` fail with
  `DeadlineExceeded` after `startup_timeout`, and a pool reports the failed
  instance.
- Growing an array of arrays until the limit fails with
  `LimitExceeded("engine heap")` on QuickJS and V8, and the process
  survives. A script that catches QuickJS's out-of-memory error and
  continues still stops, and its instance retires.
- An `ArrayBuffer` over V8's array buffer budget throws a `RangeError` that
  JavaScript can catch.
- On Boa, a loop past `loop_iteration_limit` stops, and exponential
  recursion is recorded as running past the deadline.
- The fuzz targets gain an action that arms a short `busy_timeout`, to
  check that a stop in the middle of a host operation leaves the bridge
  consistent.

## Order of work

1. Done: the `Interrupt` type, classification of errors and retirement,
   and the QuickJS interrupt handler for the invocation deadline, in
   `crates/fetchlet/tests/interrupts.rs` with V8 alongside.
2. `busy_timeout` and `startup_timeout` across engines: the V8 watchdog and
   startup wait, and Boa's checks and loop iteration limit.
3. Heap limits: the QuickJS allocator, after measuring it, and V8's heap
   and array buffer budgets.
4. The Boa VM interrupt proposal upstream.

Each step updates [Resource policy](../resource-policy.md) and
[Security](../security.md).

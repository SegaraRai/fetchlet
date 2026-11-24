# Research: stopping JavaScript that never yields, and heap limits

The invocation deadline, `Limits::busy_timeout` and
`Limits::startup_timeout` stop JavaScript that never yields on QuickJS and
V8, and retire the instance. Boa stops it at its next promise job or host
call, and `BoaOptions::loop_iteration_limit` bounds loops by count;
JavaScript that does neither runs on. QuickJS and V8 stop an instance that
reaches its heap limit with `LimitExceeded("engine heap")`; Boa has no heap
limit. This document
records what each engine provides, as of the versions in `Cargo.lock`, and
designs enforcement on top of it: stopping non-yielding JavaScript at the
invocation deadline, during initialization and after a busy budget, and
bounding each instance's heap.

## Status

| Engine         | Non-yielding JavaScript                                                                                                                                                                                                                                       | Heap                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| QuickJS (0.14) | Stopped at the deadline, past the busy timeout and past the startup timeout. The interrupt handler and the job loop check the instance's `Interrupt`; the evaluation fails and the instance retires.                                                          | A counting allocator enforces `memory_limit_bytes`; the instance stops and retires, even if JavaScript caught the error. |
| Boa (0.22)     | Stopped at the next promise job or host call once the deadline, busy timeout or startup timeout passes. `loop_iteration_limit` stops a loop by count. JavaScript that queues no job, calls no host and runs no limited loop, such as deep recursion, runs on. | None.                                                                                                                    |
| V8 (deno_core) | Stopped at the deadline, past the busy timeout and past the startup timeout. A watchdog thread per instance, and the caller dropping the call, terminate the isolate; the instance retires. One loop shape is not stopped (see below).                        | `heap_limit_bytes` stops the isolate near the limit; `array_buffer_limit_bytes` refuses buffers with a `RangeError`.     |

`crates/fetchlet/tests/interrupts.rs` stops, on QuickJS and V8, a loop, a
loop inside `try`/`catch`, a loop in a promise reaction, an endless
microtask chain, a loop of host calls, regular expression backtracking and
exponential recursion, at the deadline and past the busy timeout, each
within the timeout plus scheduling slack. On Boa it stops the microtask
chain and the host calls. On every engine it checks that the instance
retires, that a pool replaces it, that a call which yields often outlasts
the busy timeout, and that a module looping at top level fails `build`
past the startup timeout. `crates/fetchlet/tests/boa_options.rs` stops a
loop past `loop_iteration_limit`. `crates/fetchlet/tests/heap.rs` exhausts
the heap on QuickJS and V8, in a call, in a call that catches the error and
carries on, and at startup, and checks that the process survives, that the
instance retires and that a pool replaces it, and that V8 refuses an
`ArrayBuffer` past its budget with a `RangeError` the call can catch.

V8 does not deliver termination to a hot loop whose body allocates with
`new Array(n).fill(value)` for an `n` of 200 or more, on V8 150.4 through
deno_core 0.413: the watchdog's `terminate_execution` and the
near-heap-limit callback's both go unanswered, so neither the time limits
nor the heap limit stop it, and a heap limit lets it grow until V8 ends the
process. The same loop with `new Array(16).fill(value)`, with `fill` on an
existing array, or with an array built by `push` stops within the busy
timeout. The probes ran against the shipped V8 build; where V8 drops the
interrupt has not been traced. Deployments that run untrusted code on V8
need a process boundary for this case.

CPU time would not count time spent waiting for a busy host. Measuring it
costs a system call, and V8's thread would need its own clock. CPU time can
be added later as a separate budget if a deployment needs it.

### One interrupt per instance

Each instance gets a crate-internal `Interrupt`, shared between the
instance's thread and anything that may stop it:

```rust
pub(crate) struct Interrupt {
    inner: Arc<InterruptState>,
}

struct InterruptState {
    /// `Limits::busy_timeout`, fixed when the instance is built.
    busy: Option<Duration>,
    /// The armed deadline, as nanoseconds since a process-wide base
    /// instant; 0 when none is armed.
    deadline: AtomicU64,
    /// Whether that deadline is an invocation's or the startup's.
    deadline_reason: AtomicU8,
    /// When the current entry into JavaScript exceeds the busy timeout;
    /// 0 outside JavaScript.
    busy_until: AtomicU64,
    /// Why the engine was stopped, once it has been.
    reason: AtomicU8,
}
```

- `arm(deadline)` and `arm_startup(deadline)` when an evaluation starts:
  an invocation, or the module's evaluation at startup.
- `enter()` at each entry into JavaScript, the first evaluation and each
  return from the loop's wait, starts the busy clock; `leave()` before the
  loop waits stops it.
- `disarm()` when the evaluation ends.
- `expired()` reads the clock only while something is armed, records the
  reason and returns `true`.
- `stopped()` returns the recorded reason.

An engine error is classified by the recorded reason, not by its message:
`Error::DeadlineExceeded` for the deadline and for startup, and
`Error::LimitExceeded("engine busy time")` for the busy budget. The heap
limits will add `Error::LimitExceeded("engine heap")`. A stop whose reason
is recorded always retires the instance, even when the evaluation finished
before the engine noticed it.

### Stopping on each engine

**QuickJS.** The interrupt handler returns `interrupt.expired()`, which
reads the clock only while an evaluation is armed or JavaScript runs under
a busy timeout. Reading it every 10,000 polls costs little next to the
interpreter, and no watchdog thread is needed. The handler covers loops,
recursion, regular expressions, promise jobs and module evaluation, because
all of them run through the interpreter. `Ctx::execute_pending_job`
discards the exception of a job that threw, the interrupt's included, so
fetchlet drives the job queue itself and checks the interrupt between jobs.
Long native built-ins with no polls inside, such as joining a huge array,
are bounded by the heap limit.

**V8.** The caller's timer drops an evaluation at its deadline, and
`Cancellation` terminates the isolate. An instance with a busy or startup
timeout also starts a watchdog thread, which polls `interrupt.expired()`
every quarter of the shorter timeout, between 1 ms and 100 ms, and calls
`terminate_execution` once it expires. The worker hands the watchdog the
isolate handle before it evaluates the module, so the watchdog covers
startup too. Polling keeps arming and disarming to atomic stores; a thread
per instance matches the worker thread each V8 instance already has. When
the termination lands in a microtask, V8 ends it once no JavaScript runs,
leaving the invocation's promise pending, so fetchlet's loop checks the
recorded stop before it waits.

**Boa.** Boa cannot be stopped from outside, so fetchlet does what Boa
allows and states the gap:

- **Checks between pieces of JavaScript.** `call_job_callback` and the
  bridge's native functions check `interrupt.expired()`. On expiry they
  return `JsError::from(RuntimeLimitError::LoopIteration)`, which
  JavaScript cannot catch, and the instance retires. This stops microtask
  chains and scripts that call the host in a loop, during invocations and
  at startup.
- **Loop iteration limit.** `BoaOptions::loop_iteration_limit`, owned by
  the caller, applies `set_loop_iteration_limit`. It caps the loop
  iterations of a single frame by count rather than time, and its error is
  reported as `Error::JavaScript`.
- **Remaining gap.** JavaScript that runs no limited loop, makes no host
  call and queues no job can still run without bound. Exponential
  recursion within the recursion limit is the example. Closing it needs an
  interrupt poll inside Boa's VM, which fetchlet does not pursue.
  Deployments that run untrusted code use QuickJS or V8, or a process
  boundary around Boa.

Detaching Boa's thread and leaving it to spin was considered and rejected.
The thread would keep its CPU and memory indefinitely, and the same
discussion notes that ending it would not free the GC heap. The process has to restart
to recover either way.

### Heap limits

**QuickJS.** `set_memory_limit` is replaced by an `Allocator` passed to
`Runtime::new_with_alloc`. The allocator counts each block's usable size
plus its 8-byte header against `memory_limit_bytes`, the same total
QuickJS's own `malloc_size` keeps, and refuses allocations past it. On a
refusal it records `interrupt.stop(Heap)`. Then:

- the failure is named precisely, whatever exception QuickJS manages to
  build, which fixes the `Null"null"` report;
- the next interrupt poll stops JavaScript that caught the error and
  carried on;
- the instance retires after the invocation.

The allocator is a thin counter over Rust's global allocator. On a script
that builds and serializes 50,000-object arrays and concatenates strings,
release builds of the counting allocator and of the system allocator with
`set_memory_limit` took the same time within run-to-run variation (best of
five: 2.31 s and 2.33 s in one round, 2.61 s and 2.29 s in another). Its
counter has no atomics, because a QuickJS runtime allocates on one
thread.

**V8.** `V8Options::heap_limit_bytes` passes `heap_limits(0, max)` through
`create_params`. A near-heap-limit callback records `interrupt.stop(Heap)`,
calls `terminate_execution`, and the first time returns the current limit
plus headroom (a quarter of the limit, at least 8 MiB) so that termination
can unwind; later calls keep the limit. The instance retires. An array
buffer allocator counts backing stores against
`V8Options::array_buffer_limit_bytes`, which defaults to the heap limit, and
refuses past it, which JavaScript sees as a `RangeError`. These budgets
have precise limits:

- A single allocation larger than the headroom, such as one enormous
  string, or growth past the headroom before the termination lands, ends
  the process with V8's fatal out-of-memory error. The loop shape above
  that V8 does not terminate is one such case.
- The headroom is extra memory each instance may briefly use; a pool's
  bound is `max` times the limit plus the headroom.
- Backing stores that deno_core creates from Rust buffers, such as the
  bytes a host operation returns, are not counted against the array buffer
  budget; the body and message budgets in `Limits` bound them.

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

| Setting                               | Owner  | Default        | fetchlet-http `Server`                                        |
| ------------------------------------- | ------ | -------------- | ------------------------------------------------------------- |
| `Limits::busy_timeout`                | Caller | `None`         | Not set yet; to be measured, in seconds                       |
| `Limits::startup_timeout`             | Caller | `None`         | Not set yet; from the slowest example's startup               |
| `QuickJsOptions::memory_limit_bytes`  | Caller | `None`         | 64 MiB, as before                                             |
| `V8Options::heap_limit_bytes`         | Caller | `None`         | Not set yet; from [startup and memory](startup-and-memory.md) |
| `V8Options::array_buffer_limit_bytes` | Caller | The heap limit | The heap limit                                                |
| `BoaOptions::loop_iteration_limit`    | Caller | `None`         | Not set yet; to be measured, with a large margin              |

`Backend::with_default_*` helpers set the engine values where the caller
has not, as they do for stacks and the QuickJS heap today.

## Tests

Each test runs on every engine and expects the same outcome. The Boa cases
listed under its remaining gap are the only exception. Those not yet in
`crates/fetchlet/tests` are the held connection, the pool's report of a
failed startup and the fuzz action.

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
- On Boa, a loop past `loop_iteration_limit` stops.
- The fuzz targets gain an action that arms a short `busy_timeout`, to
  check that a stop in the middle of a host operation leaves the bridge
  consistent.

## Order of work

1. Done: the `Interrupt` type, classification of errors and retirement,
   and the QuickJS interrupt handler for the invocation deadline, in
   `crates/fetchlet/tests/interrupts.rs` with V8 alongside.
2. Done: `busy_timeout` and `startup_timeout` across engines, with the V8
   watchdog, and Boa's checks and loop iteration limit.
3. Done: heap limits, with the QuickJS counting allocator and V8's heap and
   array buffer budgets.
4. fetchlet-http's `Server` defaults for the busy and startup timeouts, V8's
   heap limit and Boa's loop iteration limit, measured against the
   examples.
5. Trace where V8 drops termination in a loop around
   `new Array(n).fill(value)`, and work around it or report it.

Each step updates [Resource policy](../resource-policy.md) and
[Security](../security.md).

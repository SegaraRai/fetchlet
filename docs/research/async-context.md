# Research: async context propagation

Framework servers keep the current request in `AsyncLocalStorage`. Next.js,
SvelteKit's `getRequestEvent`, Nuxt through unctx, SolidStart and TanStack
Start depend on it, and React's server renderer reads its request cache the
same way. `asyncContext: "serialized"`
([build options](../../packages/fetchlet/docs/build.md)) keeps a store until
the `run` callback's promise settles, so overlapping `run`s inside one
invocation see the last started store. This document designs propagation
that isolates concurrent runs, states what each engine needs, and records
the semantics chosen where engines and runtimes differ. V8 and Boa implement
it as `asyncContext: "propagated"`; QuickJS waits for an engine API.

## Requirements

- **Isolation.** Code continuing after `await`, a `then` callback, a timer or
  a message sees the context that was current when it was scheduled, not the
  context of whatever ran last. Two `run`s started together inside one
  invocation never observe each other's stores.
- **The `node:async_hooks` surface frameworks call.** `AsyncLocalStorage`
  with `run`, `getStore`, `enterWith`, `exit`, `disable` and the static
  `snapshot` and `bind`, and `AsyncResource` with `bind` and
  `runInAsyncScope`, which some libraries use to carry context into
  callbacks.
- **Invocation boundaries.** Each invocation starts in an empty context. No
  context crosses from one invocation to the next, including through work a
  previous invocation left behind. Background work registered with
  `fetchlet.waitUntil` keeps the context it was registered in.
- **One semantics on every engine.** Every engine with a slot gives the
  results Node gives for the same program. On an engine without one, a
  propagated artifact fails when it loads instead of sharing stores.

## Semantics

The model is the TC39 AsyncContext proposal (Stage 2): `AsyncContext.Variable`
and `AsyncContext.Snapshot` over one immutable mapping from variables to
values.

- The agent holds one **current mapping**. `variable.run(value, fn)` replaces
  it with a copy that maps the variable to `value`, calls `fn` and restores
  the previous mapping when `fn` returns or throws.
- When a promise reaction is registered (`then`, `await`, and the internal
  `then` of thenables), the current mapping is captured with the reaction.
  When the reaction job runs, that mapping becomes current and the previous
  one is restored afterwards. This is the proposal's capture point in
  `PerformPromiseThen`.
- `Snapshot` captures the current mapping, and `snapshot.run(fn)` runs `fn`
  with it. Host task sources use snapshots (see [host task sources](#host-task-sources)).

The mapping is a frozen `Map` copied on write. Reads are a lookup in the
current mapping, and `run` allocates one map per call; frameworks call `run`
once or a few times per request, so the copy cost is bounded by the number
of variables, which is small.

`AsyncLocalStorage` maps onto this model as Node's `AsyncContextFrame`
implementation does: a storage is a variable, `run` is `variable.run`,
`exit(fn)` runs `fn` with the variable unset, `snapshot` and `bind` use
`Snapshot`, and `enterWith(store)` replaces the current mapping with one
that maps the storage to `store` until the current task or reaction job
ends, when the captured mapping is restored. `disable` unsets the variable
in the current mapping.

## Architecture

The design splits into a profile part shared by all engines and one slot per
engine.

**Profile.** `@fetchlet/web/async-context` implements `Variable` and
`Snapshot` over the engine's slot, `__fetchletAsyncContext`, whose `get()`
returns the current mapping and `set(mapping)` replaces it. The engine
installs the slot before the bundle runs. The module does not install a
global `AsyncContext`: none of the runtimes fetchlet aligns with exposes
one, and the proposal may still change. `fetchlet/build/propagated-async-hooks`,
the `node:async_hooks` replacement, imports it, and the profile's timers,
`MessageChannel` and rejection events run their callbacks in its
snapshots.

**Engine slot.** Each engine stores the current mapping and carries it
through promise reactions natively, so `await` in engine code, in the
Streams polyfill and in framework code all propagate without source changes.

| Engine  | Slot                                                                                                                                                                                                                                                                                                                                           | Status                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| V8      | V8's continuation-preserved embedder data, which V8 captures when a promise reaction is created and restores when the reaction runs. Node's `AsyncContextFrame` and Deno's `AsyncLocalStorage` are built on it. The slot is deno_core's `Deno.core.getAsyncContext` and `setAsyncContext`.                                                     | Implemented           |
| Boa     | The Context's `HostHooks`. Boa 0.22 calls `make_job_callback` in `perform_promise_then`, which `await` and thenable jobs also use, and `call_job_callback` when the job runs. The first stores the current mapping in the `JobCallback`'s host-defined field, which the garbage collector traces; the second makes it current around the call. | Implemented           |
| QuickJS | None yet. quickjs-ng 0.16.2 calls its promise hook only on promise creation, resolution and thenable jobs. Reaction jobs, including every `await` continuation, run with no hook, and `await` creates no derived promise to attach a context to.                                                                                               | Waiting on quickjs-ng |

Boa's Context host data is not traced, so the slot keeps the current mapping
on an internal object that the global object holds,
`__fetchletAsyncContextSlot`, and the hooks read and write it there.

**QuickJS.** quickjs-ng
[issue #1919](https://github.com/quickjs-ng/quickjs/issues/1919) asks for an
embedder value carried through promise jobs, and
[pull request #1920](https://github.com/quickjs-ng/quickjs/pull/1920) adds
`JS_GetContinuationData` and `JS_SetContinuationData`, which capture the
value when a reaction is registered and restore it around the job, as V8
does. fetchlet does not patch QuickJS. Once a quickjs-ng release with that
API reaches rquickjs, the QuickJS slot calls it; until then QuickJS
artifacts use `"serialized"`.

**Fallback.** An engine without a slot uses `asyncContext: "serialized"`.
`fetchlet.json` records the mode an artifact was built with. The propagated
`node:async_hooks` module throws when it is evaluated without a slot, so a
propagated artifact fails to load on QuickJS. The fallback lasts only until
QuickJS has a slot (see [rollout](#rollout)).

## Host task sources

Promise reactions propagate through the engine slot. Callbacks that the
profile or the host schedules capture a snapshot when they are scheduled and
run inside it:

| Source                                   | Context the callback runs in                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `setTimeout`, `setInterval`              | The context of the call that scheduled it, for every repetition |
| `AbortSignal.timeout` abort listeners    | The context of the `timeout()` call                             |
| `queueMicrotask`                         | The context of the call                                         |
| `dispatchEvent` listeners                | The context of the dispatch, as for any synchronous call        |
| `MessagePort` messages                   | The context in which the `MessageChannel` was created           |
| `unhandledrejection`, `rejectionhandled` | The context in which the promise was rejected                   |
| `fetch` completion, Streams              | Promise reactions, propagated by the engine                     |
| Invocation start, response body pulls    | The empty context                                               |

The invocation entry points (`__fetchletInvocation` in `host-bridge/`,
and `background.ts`) and each host event loop step set the empty mapping
before calling into the application, so a mapping left current by a
previous invocation or task cannot leak. Background work keeps its own
context through its promise reactions.

## Precedents

Where the proposal leaves a choice to the host, fetchlet follows Node,
checked against Deno and Cloudflare Workers. Node 26.13, with and without
`AsyncContextFrame`, and Deno 2.9.8 ran the same programs with
`AsyncLocalStorage`; Workers' behavior is from its
[documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/).

| Case                                | Node                                         | Deno                           | Workers             | fetchlet     |
| ----------------------------------- | -------------------------------------------- | ------------------------------ | ------------------- | ------------ |
| Generator and async generator steps | Context of `next()`                          | Same as Node                   | Not documented      | Same as Node |
| `then` callbacks                    | Context of registration                      | Same as Node                   | Same as Node        | Same as Node |
| Thenable `then`                     | Context of the `await`                       | Same as Node                   | Not fully supported | Same as Node |
| `setTimeout`, `queueMicrotask`      | Context of the call                          | Same as Node                   | Not documented      | Same as Node |
| `AbortSignal.timeout` listeners     | Context of `timeout()`                       | No context                     | Not documented      | Same as Node |
| `EventTarget` listeners             | Context of `dispatchEvent`                   | Same as Node                   | Not documented      | Same as Node |
| `MessagePort` listeners             | Context of the channel's creation            | Context of setting `onmessage` | Not documented      | Same as Node |
| `unhandledrejection` handlers       | Context of the rejection                     | Same as Node                   | Same as Node        | Same as Node |
| `enterWith`                         | Lasts to the end of the enclosing run or job | Same as Node                   | Not provided        | Same as Node |
| `disable`                           | Unsets the store                             | Same as Node                   | Not provided        | Same as Node |
| Global `AsyncContext`               | None                                         | None                           | None                | None         |

`enterWith` and `disable` stay because frameworks written for Node call
them; code written for Workers does not call them. When the proposal
reaches Stage 3 and an engine ships it, the profile's `Variable` and
`Snapshot` follow its text, and a global `AsyncContext` is reconsidered
then.

## Alternatives

- **Promise hooks (init, before, after).** The approach behind Node's former
  `async_hooks` implementation of `AsyncLocalStorage`. QuickJS cannot support
  it for `await` (no hook around reaction jobs and no derived promise), and it
  attaches context to promise creation rather than reaction registration,
  which the proposal rejected.
- **Patching `Promise.prototype.then`.** Native `await` does not call `then`,
  so continuations of async functions would lose the context.
- **A build-time transform** that saves the mapping before each `await` and
  restores it after. It needs no engine change, but it must rewrite every
  async function and generator in framework and library code, including
  `for await`, async generators and code that `eval` or `Function` creates,
  and it adds work to every `await`. The engine change is smaller and covers
  all code.

## Verification

- `crates/fetchlet/tests/async_context.rs` runs one program on each engine
  through the slot alone: two `run`s started with `Promise.all` each see
  only their own value after several awaits, `then` callbacks run in their
  registration context, thenables in the awaiting context, async generators
  in the context of each `next()`, `for await` in the loop's context,
  `enterWith` lasts to the end of its run, and a value entered by one
  invocation is gone in the next. The expected values are Node's for the
  same program. On QuickJS it asserts that there is no slot.
- `vp run test:matrix` checks every host task source above with the
  profile on QuickJS, Boa, V8 and the Node reference host, which provides
  the slot through Node's `AsyncLocalStorage`.
- `packages/web/tests/async-context.test.ts` tests `Variable`, `Snapshot`
  and the task sources over a slot backed by Node's `AsyncContextFrame`.
- `packages/fetchlet/tests/build/propagated-async-hooks.test.ts` runs each
  `AsyncLocalStorage` and `AsyncResource` scenario with fetchlet's classes
  and with Node's, and requires the same result.

## Cost

fetchlet-bench's `async-context` tool ([README](../../tools/bench/README.md#async-context))
times `AsyncLocalStorage` inside the engine in a release build, with the
serialized and the propagated `node:async_hooks`: 50,000 operations, the
median of five rounds, run twice. Nanoseconds per operation, the two runs
as a range (Boa 0.22.0, V8 150.4.0 through deno_core 0.413.0, quickjs-ng
through rquickjs 0.14.0):

| Operation                         | V8 serialized | V8 propagated | Boa serialized | Boa propagated | QuickJS serialized |
| --------------------------------- | ------------- | ------------- | -------------- | -------------- | ------------------ |
| `run` around a synchronous call   | 138–165       | 80–82         | 25,200–27,400  | 13,000–14,400  | 3,200–4,200        |
| `getStore` inside a run           | 6             | 11–12         | 600–830        | 1,780–1,980    | 160–190            |
| An `await` inside a run           | 45–48         | 46–58         | 7,600–13,200   | 7,600–8,600    | 590–690            |
| An `await` outside any run        | 48–52         | 45–55         | 9,200–9,400    | 7,600–8,300    | 670–710            |
| `run` around one `await` and read | 212–262       | 122–149       | 40,800–44,600  | 22,300–24,000  | 4,900–5,000        |

Propagation costs nothing on `await`: on V8 and Boa an `await` takes the
same time with either implementation, inside a run or outside one, within
the spread between runs, so the slot's capture and restore do not show next
to the engine's own reaction job. A propagated `run` takes about half the
time of a serialized one, which keeps a list of active runs per storage
and builds a map for each. `getStore` takes about twice as long when
propagated: 6 ns more per read on V8, and about 1.2 µs more on Boa, whose
slot is read through a host object. A request breaks even on Boa at about
ten reads per `run`, and any count stays in microseconds next to the
milliseconds a Boa page takes. Switching the adapters to propagation
therefore does not need a faster slot.

## Rollout

The profile module and its task sources, the V8 and Boa slots, and
`asyncContext: "propagated"` are implemented. `"serialized"` stays until
QuickJS has a slot, because the framework adapters build artifacts that may
run on any engine. When an rquickjs release includes quickjs-ng's
continuation data API ([#1920](https://github.com/quickjs-ng/quickjs/pull/1920)),
one change implements the QuickJS slot, switches every adapter to
propagation, and removes `"serialized"` together with the `asyncContext`
option. [TODO](../TODO.md#framework-runtime-needs-beyond-wintertc) tracks
the steps and the end-to-end check in the asynchronous SvelteKit example;
that change also measures the QuickJS slot as [above](#cost).

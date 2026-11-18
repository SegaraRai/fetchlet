# Research: async context propagation

Framework servers keep the current request in `AsyncLocalStorage`. Next.js,
SvelteKit's `getRequestEvent`, Nuxt through unctx, SolidStart and TanStack
Start depend on it, and React's server renderer reads its request cache the
same way. fetchlet provides `asyncContext: "serialized"` today
([build options](../../packages/fetchlet/docs/build.md)): a store lasts until
the `run` callback's promise settles, and overlapping `run`s inside one
invocation see the last started store. This document designs propagation
that isolates concurrent runs on every engine, and states what each engine
needs.

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
- **One semantics on every engine.** QuickJS, Boa and V8 give the same
  results for the same program, or the build refuses the combination.

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

**Profile.** A module of `@fetchlet/web`, `async-context.ts`, implements
`Variable` and `Snapshot` over two host functions: `get()` returns the
current mapping and `set(mapping)` replaces it. It does not install a global
`AsyncContext`, since the proposal may change; the `node:async_hooks`
replacement of `fetchlet/build` imports it. The module also wraps the host
task sources below.

**Engine slot.** Each engine stores the current mapping and carries it
through promise reactions natively, so `await` in engine code, in the
Streams polyfill and in framework code all propagate without source changes.

| Engine  | Slot                                                                                                                                                                                                                                                                                                                                                              | Status                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| V8      | V8's continuation-preserved embedder data. V8 captures it when a promise reaction is created and restores it when the reaction runs; Node's `AsyncContextFrame` and Deno's `AsyncLocalStorage` are built on it. deno_core exposes it as `Deno.core.getAsyncContext` and `setAsyncContext`, and rusty_v8 as `get_` and `set_continuation_preserved_embedder_data`. | Available                  |
| Boa     | The `HostHooks` of the Context. Boa 0.22 calls `make_job_callback` in `perform_promise_then`, which `await` and thenable jobs also use, and `call_job_callback` when the job runs. The first stores the current mapping in the `JobCallback`'s host-defined field, which the garbage collector traces; the second makes it current around the call.               | Available, needs the hooks |
| QuickJS | No mechanism. quickjs-ng 0.16.2 calls its promise hook only on promise creation, resolution and thenable jobs. Reaction jobs, including every `await` continuation, run with no hook, and `await` creates no derived promise to attach a context to.                                                                                                              | Needs an engine change     |

Boa's Context host data is not traced, so the slot itself must not hold JS
values there. The Boa slot keeps the current mapping on an internal object
reachable from the global object, and the hooks read and write that object.

**QuickJS change.** `perform_promise_then` is the single point where every
reaction is registered (`then`, `await`, async generators and thenables), and
`promise_reaction_job` and `js_promise_resolve_thenable_job` are where they
run. The change adds a current-mapping `JSValue` to the runtime, copies it
into `JSPromiseReactionData` when a reaction is registered, swaps it in and
out around the job, marks it during garbage collection, and exposes
`JS_GetAsyncContext` and `JS_SetAsyncContext`. It is a few dozen lines in
`quickjs.c`. Propose it to quickjs-ng first; until a release contains it,
carry it as a patch on rquickjs-sys's bundled source through a
`[patch.crates-io]` entry, with the patch file and the upstream revision it
applies to recorded in the repository.

**Fallback.** An engine without a slot keeps `asyncContext: "serialized"`.
`fetchlet.json` records which mode an artifact was built with, and the App
refuses an artifact built for propagation on an engine without a slot, as
part of [capability negotiation](../TODO.md#capability-negotiation).

## Host task sources

Promise reactions propagate through the engine slot. Callbacks that the
profile or the host schedules capture a snapshot when they are scheduled and
run inside it:

| Source                                             | Context the callback runs in                                    |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `setTimeout`, `setInterval`, `AbortSignal.timeout` | The context of the call that scheduled it, for every repetition |
| `queueMicrotask`                                   | The context of the call                                         |
| `MessagePort` messages                             | The context of `postMessage`                                    |
| `dispatchEvent` listeners                          | The context of the dispatch, as for any synchronous call        |
| `fetch` completion, Streams                        | Promise reactions, propagated by the engine                     |
| `unhandledrejection`, `rejectionhandled`           | The empty context                                               |
| The start of an invocation, response body pulls    | The empty context                                               |

The entry scripts (`invoke.js`, `response-body.js`, `background.js`) set the
empty mapping before calling into the application, so a mapping left current
by a previous invocation cannot leak. Background work keeps its own context
through its promise reactions.

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

- Rust tests per engine, through the profile: a value set by `run` survives
  `await`, `then`, thenables, async generators and `for await`; two `run`s
  started with `Promise.all` each see only their own value after several
  awaits; `enterWith` lasts until the end of the current job; `exit`,
  `snapshot` and `bind` match Node; a new invocation starts empty after one
  that left a mapping current; background work keeps its context.
- The same cases run on the Node reference host against Node's
  `AsyncLocalStorage`, so each engine is compared with Node.
- The asynchronous SvelteKit example (`rendering: "async"`) gains a page that
  renders two concurrent `getRequestEvent` readers, and its end-to-end check
  asserts each sees its own request. That replaces the limitation recorded
  under [asynchronous SvelteKit SSR](../TODO.md#asynchronous-sveltekit-ssr).
- Measure `run`, `getStore` and an `await` loop per engine with the bench
  tools, against the serialized implementation.

## Rollout

1. The profile module with `Variable` and `Snapshot`, its unit tests over a
   fake slot, and the snapshot wrapping of timers, `queueMicrotask` and
   `MessagePort`.
2. The V8 slot, and a `node:async_hooks` replacement over the profile module
   (`asyncContext: "propagated"`), verified on V8.
3. The Boa slot through `HostHooks`.
4. The QuickJS change, proposed upstream and carried as a patch.
5. Make `"propagated"` the default where the backend has a slot, keep
   `"serialized"` as the explicit fallback, and record the mode in
   `fetchlet.json` for capability negotiation.

## Open questions

- Generators: the proposal discusses whether a generator resumes in the
  context of `next()` or of its creation. Follow the proposal's current text
  and pin it with a test on each engine.
- Event listeners registered in one context and dispatched in another by the
  host, such as `AbortSignal` abort events from a timeout, run in the
  dispatch context; confirm against the proposal's web integration notes.
- Whether to expose a global `AsyncContext` once the proposal reaches Stage 3.

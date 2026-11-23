# Security

In fetchlet, security means explicit authority, owned resources, isolation
that fits the deployment, and tests and fuzzing that keep checking them.

## Execution boundary

| Subject             | Contract                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound fetch      | Only to the configured services and allowed normalized origins. `globalThis.fetch` is writable, as in WebIDL; a replacement still reaches the host fetch and Rust's policy |
| Rewrites, redirects | The final destination is authorized on every send; credentials are bound to their destination                                                                              |
| Env and services    | Bindings Rust chose, fixed before the module is evaluated                                                                                                                  |
| Engine globals      | Only fetchlet's host operations; V8 builds remove deno_core's `Deno` and `__bootstrap`, whose built-in ops include `op_panic` and `op_print`                               |
| Host functions      | Off the global object; the bundle's runtime claims them once while the bundle is evaluated, and later code reaches the host only through the APIs built on them            |
| JavaScript state    | Reused within an app, by each of its instances; assign one app per application, tenant and authority configuration                                                         |
| Async resources     | The invocation owns transport futures and drops them when it ends                                                                                                          |
| Tickets             | Bound to the invocation's generation; each completion is delivered once within the call                                                                                    |
| Cancellation        | Instances with cancelled or unfinished work are retired; `CancelledCalls::Finish` lets a cancelled call end in its own invocation first, within its deadline               |
| Host errors         | Guests see stable codes and general messages; details stay in Rust                                                                                                         |
| Budgets             | The caller chooses `Limits` and engine options                                                                                                                             |

Transports are part of this boundary: Rust implements single-hop sends,
cancellation on drop, size checks while receiving, and DNS and destination
address policy. [Host services](host-services.md) and [resource
policy](resource-policy.md) give the details.

## Deployment and isolation

The verified configuration runs trusted application code in the same
process. The permission policy controls fetchlet's host operations.
Isolation from engine bugs or memory corruption in native code requires an
outer boundary: a separate process, an OS sandbox or similar.

Deadlines are cooperative. Stopping JavaScript that never yields, stopping
initialization, and bounding the whole heap are per-engine work. Running
third-party code requires choosing the enforcement it needs and checking
what each engine provides. Ahead-of-time compiled code is native code.

The Web API profile is verified against pinned SSR applications and
selected standards tests. [Conformance](conformance.md) records the
selection, unsupported modes and known failures.

## Regular tests

```bash
vp run test:rust
vp run build:fixtures
vp run test:matrix
vp run test:host
```

`crates/fetchlet/tests/guest_isolation.rs` checks on every engine that no
engine internals are guest globals, that the host functions are claimed
once and are not globals afterwards, and that an impossible `ArrayBuffer`
transfer throws instead of aborting. The Rust tests also cover exact origin
matching, the authorization order of rewrites and redirects, credential
lifetime, body and header budgets, invalid headers and statuses, future drop,
ticket lifetime and app state transitions.

The engine matrix uses real bundles: plain functions, Hono JSX, SvelteKit
SSR and actions, the 23 Web API probes and host round trips, with a Node
reference run on the same fixtures. Results apply to the recorded
dependency versions, profile and fixtures.

WPT and Test262 sources are stored with their licenses, pinned commits and
hashes. CI detects new failures, timeouts, harness errors and improvements;
known failures stay recorded as failures. The runner's self-tests cover
assertion failures, async completion, global scripts, modes and process
exit.

## Fuzzing

`fuzz/fuzz_targets/fetch_service.rs` mutates URLs, methods, headers,
bodies, rewrite targets and redirect chains, and runs the real Rust
`FetchService` with a mock transport. It checks the origin, method, framing
headers and redirect count of every request that reaches the transport.

`fuzz/fuzz_targets/bridge_bodies.rs` mutates sequences of operations a guest
can perform through native callbacks: storing and claiming byte handles,
`body.read`, `body.readAll`, `body.readText`, `body.cancel` and
`fetch.poll` on body sources, accepting a WebSocket upgrade, opening
channels from an accepting, a refusing and an unbound service,
`channel.write`, `channel.buffered` and `channel.close`, arbitrary host
operations, producer chunks, ends and failures, and invocation start and
end. It compares the results with a model and checks that:

- a guest buffer is claimed at most once, and only the latest unclaimed
  buffer remains;
- handles and body ids never cross invocations;
- a body's handle never reaches a channel, nor a channel's a body, and a
  released handle names nothing;
- ending an invocation releases JavaScript's end of its channels;
- an open from a service settles at the next poll, once, as an open or a
  refusal, and a channel closed before then ends with 1006;
- a write is queued at the next poll unless its channel closed, and
  `channel.buffered` counts exactly the bytes queued;
- body reads return the producer's chunks in order, within budget, and a
  whole-body read returns all of them as one buffer or as their UTF-8
  text;
- completion, error, cancellation and invocation end release the producer,
  and a body has at most one read in flight.

The private bridge is reached through a hidden harness (`BridgeHarness`)
behind the `fuzzing` feature. A mutation that deliberately stops releasing
producers is caught by the model within seconds.

Seed corpora are in `fuzz/corpus/fetch_service/*.json`; generated corpora
and crash artifacts stay local. Failures are minimized and added as
regression tests. The fuzz crate shares the workspace and `Cargo.lock`.

```bash
cargo install cargo-fuzz --version 0.13.2 --locked --root .cache/tools/cargo-fuzz
vp run test:fuzz
```

Fuzzing uses nightly Rust. On Windows it needs the Visual Studio C++
AddressSanitizer; `tools/rust/fuzz.ts` finds MSVC and puts the ASan runtime
on `PATH` ([setup](https://rust-fuzz.github.io/book/cargo-fuzz/windows/setup.html)).
The default smoke run executes each target with AddressSanitizer for up to
one million runs or 30 seconds; arguments to the script change both. The
last run is in [reference](reference/README.md#fuzzing).

## Continuous checks

`.github/workflows/test.yml` runs as parallel jobs: the Rust tests on
Windows and Linux, rustfmt and clippy on Linux, conformance on both, the
type and format checks, framework and host matrices, build, package and
example tests on both, and AddressSanitizer fuzzing on Linux. Each job
restores a Cargo dependency cache that only `main` saves.

Shared-handle tests on all three engines cover cancelling started calls,
queue backpressure, and refusing and draining work on shutdown. The HTTP
contract tests cover origins, body budgets, client context, binary bodies,
cookies and general error responses. Each framework example runs its HTTP
and browser checks.

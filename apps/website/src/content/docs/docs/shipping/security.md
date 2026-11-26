---
title: "Security"
slug: docs/shipping/security
description: "The execution boundary between JavaScript and Rust, permission controls, and process isolation."
---

fetchlet enforces explicit permissions, caller-owned resource limits, and
clear ownership of every host resource across the JavaScript–Rust boundary.

## Execution boundary

| Area                | Guarantee                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound fetch      | Denied by default; allowed only to configured services and exact normalized origins. Replacing `globalThis.fetch` still goes through Rust's `FetchPolicy`                  |
| Rewrites & redirects | Every redirect hop is re-authorized against the final origin; credentials attach to a single send, and cross-origin redirects strip guest `Authorization` and `Cookie`     |
| Env & bindings      | Fixed read-only object defined by Rust before module evaluation; `process.env` does not expose host environment variables                                                  |
| Engine globals      | Only fetchlet's Web API profile and host operations are exposed; V8 builds strip `deno_core`'s `Deno` and `__bootstrap` globals                                            |
| Host functions      | Claimed once by the bundle's runtime at initialization and removed from `globalThis`; application code reaches Rust only through the public APIs                           |
| JavaScript state    | Isolated per `App` (and per instance inside a pool); use a separate `App` per tenant or permission profile                                                                 |
| Async resources     | Every outbound fetch, socket, channel, and body source is owned by its invocation and dropped when the invocation ends                                                     |
| Cancellation        | Cancelled or timed-out invocations retire and rebuild their engine instance (unless `CancelledCalls::Finish` is explicitly enabled for dev)                                |
| Host errors         | JavaScript receives stable error codes and generic messages; internal Rust error details never leak to the guest                                                           |
| Resource limits     | Enforced per call and per instance via `Limits` and engine options ([Resource limits](/docs/rust/resource-policy))                                                         |

Outbound transports are part of this boundary: `fetchlet-net` resolves DNS in
Rust, blocks private/loopback/link-local IP addresses by default, enforces body
size limits while receiving, and cancels on drop.

## Choosing an isolation mode

### In-process (default)

Suitable for **trusted application code** (such as your own web framework UI).
Permissions and `Limits` protect against accidental bugs, SSRF, and runaway
requests, while avoiding IPC overhead.

Keep these engine-specific boundaries in mind when running in-process:

- **Preemption:** QuickJS interrupts non-yielding loops on `timeout` /
  `busy_timeout`. V8 does as well, except for certain allocating hot loops
  unless `V8Options::reliable_termination` is enabled. Boa checks deadlines only
  at promise jobs, host calls, or `BoaOptions::loop_iteration_limit`.
- **Memory:** `Limits::heap_bytes` bounds QuickJS and V8 heaps (on V8, a single
  allocation exceeding unwinding headroom can still abort the process). Boa has
  no in-process heap limit and refuses to build if `heap_bytes` is set.
- **Native bugs:** in-process execution does not isolate against memory
  corruption bugs in the underlying JavaScript engine itself.

### Process isolation (`process` feature)

For **untrusted or third-party code**, or when you need hard CPU and memory
isolation on any engine (including Boa), enable the `process` feature and set
`Isolation::Process(ProcessOptions::new())`
([Process isolation](/docs/rust/fetchlet#process-isolation)):

- Each engine instance runs in its own child process while `HostServices`,
  policies, and credentials stay in the parent.
- The parent forcibly terminates the child on `timeout`, `busy_timeout`, or
  cancellation — satisfying `Requirements::preemption` on QuickJS, V8, and Boa.
- `ProcessOptions::memory_bytes` enforces an OS-level memory ceiling (Windows
  Job Object, Linux `RLIMIT_DATA`, or macOS physical footprint monitoring).
- If a child crashes or is killed, only that invocation fails
  (`Error::InstanceLost`) and the pool spawns a replacement process.

Combine process isolation with an OS sandbox (containers, seccomp, AppContainer,
etc.) when running hostile multi-tenant code.

## Verification

Regression tests and fuzz targets continuously exercise the host boundary,
permission checks, cancellation, and error handling across QuickJS, Boa, and V8.
See [security testing](https://github.com/SegaraRai/fetchlet/blob/main/docs/security-testing.md)
in the repository for methodology and fuzzing coverage.

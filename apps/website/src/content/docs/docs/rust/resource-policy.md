---
title: "Resource limits"
slug: docs/rust/resource-policy
description: "Configure timeouts, memory limits, body sizes, and subrequest budgets on your Rust host."
---

Every operational limit in fetchlet is explicit and configured by the Rust host
through `Limits` and engine options.

## Caller budgets (`Limits`)

Every field on `Limits` is an `Option` that defaults to `None` (unlimited).
`fetchlet_http::Server` starts from `Server::default_limits()` — a **10 s**
`busy_timeout`, a **60 s** `startup_timeout`, and a **64 MiB** heap limit on
QuickJS and V8.

| Field                     | Scope                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `timeout`                 | Total elapsed time of one call (until its streaming response body finishes), or of a Rust `FetchService` call |
| `busy_timeout`            | Continuous JS execution time before yielding to the event loop                                                |
| `startup_timeout`         | Elapsed time for initial module evaluation when building an instance                                          |
| `heap_bytes`              | Engine heap per instance on QuickJS and V8 (refused on Boa, which cannot enforce it in-process)               |
| `request_body_bytes`      | Bytes of each incoming or outbound request body (checked against declared length and running total)           |
| `request_body_chunks`     | Chunks read from an outbound JS request body                                                                  |
| `response_body_bytes`     | Bytes of each outgoing or upstream response body                                                              |
| `header_bytes`            | Total header name and value bytes in each header set                                                          |
| `url_bytes`               | Bytes of incoming and rewritten URLs                                                                          |
| `bridge_message_bytes`    | Bytes of each JSON bridge message, `Functions` result, or binary buffer sent from JS                          |
| `digest_bytes`            | Input bytes to a single `crypto.subtle.digest` or `node:crypto` hash/HMAC                                     |
| `rsa_modulus_bits`        | Maximum RSA key modulus size in `crypto.subtle.generateKey`                                                   |
| `pbkdf2_iterations`       | Maximum PBKDF2 iterations in `crypto.subtle` or `node:crypto`                                                 |
| `scrypt_memory_bytes`     | Working memory (`128 * r * (N + p + 2)`) for `node:crypto` scrypt                                             |
| `compression_streams`     | Simultaneously open `CompressionStream` / `DecompressionStream` instances per invocation                      |
| `decompressed_bytes`      | Maximum output bytes produced by a single `DecompressionStream`                                               |
| `subrequests`             | Outbound `fetch()` calls attempted per invocation (including failed/aborted calls)                            |
| `function_calls`          | Calls to `Functions` methods per invocation (sync and async, including failed calls)                          |
| `redirects`               | Maximum redirects followed per fetch (capped at 20 by the Fetch specification)                                |
| `background_timeout`      | Elapsed time for `waitUntil` tasks after the response completes                                               |
| `background_tasks`        | Maximum `waitUntil` registrations per invocation                                                              |
| `channel_message_bytes`   | Maximum size of one channel or WebSocket message in either direction                                          |
| `channel_buffer_bytes`    | Maximum queued bytes per direction on a channel                                                               |
| `open_channels`           | Channels, sockets, and client WebSockets opened by JS per invocation                                          |
| `connection_idle_timeout` | Idle timeout for a held server WebSocket connection                                                           |
| `connection_lifetime`     | Maximum lifetime of a held server WebSocket connection                                                        |

### Enforcement notes

- **Timeouts and preemption:** QuickJS and V8 interrupt non-yielding JS loops
  and retire the instance (`DeadlineExceeded` or `LimitExceeded("engine busy
  time")`). On V8, enable `V8Options::reliable_termination` if running untrusted
  allocating loops. Boa checks deadlines at promise jobs and host calls; use
  `BoaOptions::loop_iteration_limit` or
  [Process isolation](/docs/rust/fetchlet#process-isolation) for hard
  preemption.
- **Channels and WebSockets:** a JS message exceeding `channel_message_bytes` or
  `channel_buffer_bytes` closes the channel with `1009`; an expired connection
  budget closes with `1001`. Stream views automatically chunk writes within
  these budgets and apply backpressure.
- **Backpressure:** `WorkerOptions::response_body_queue` (default: 1 chunk, up
  to 64 KiB merged per pull) keeps streaming response memory bounded.
- **Fallible allocation:** host buffers whose size is chosen by JavaScript (such
  as derived keys) allocate fallibly so excessive requests return an error
  instead of aborting the process.

## Engine stack and memory options

| Option                           | Default when unset                                             |
| -------------------------------- | -------------------------------------------------------------- |
| `QuickJsOptions` stack limit     | QuickJS default (1 MiB); must be smaller than the thread stack |
| `V8Options` worker stack         | Platform thread stack size                                     |
| `V8Options` array buffer limit   | Matches `Limits::heap_bytes` (or unlimited if unset)           |
| `BoaOptions` value stack / calls | Boa defaults (10,240 slots / 512 recursion calls)              |
| `BoaOptions` loop iterations     | Unlimited                                                      |
| `WorkerOptions` native stack     | Platform thread stack size                                     |

`fetchlet_http::Server` overrides these defaults with a **64 MiB** native worker
stack, a **4 MiB** QuickJS stack limit, **131,072** Boa value-stack slots, and
**10,000** Boa recursion calls so framework SSR (including React Server
Components) runs reliably in both debug and release builds. If you build an
`App` manually without `Server`, set similar stack limits for complex SSR
frameworks.

## Fixed specification limits

Some limits come from standards or underlying types rather than caller policy:

| Limit                                 | Source                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `getRandomValues`: 65,536 bytes       | [Web Crypto API quota](https://www.w3.org/TR/webcrypto-2/#Crypto-method-getRandomValues) |
| Maximum 20 redirects                  | [Fetch Standard](https://fetch.spec.whatwg.org/#http-redirect-fetch) (callers may set fewer) |
| `node:crypto` key length: `2^31 - 1`  | Node.js `pbkdf2Sync` / `scryptSync` `keylen` bound                         |
| `usize`, `u64`, and clock ranges      | Checked arithmetic and timeout validation                                  |

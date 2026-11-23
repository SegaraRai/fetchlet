# Resource policy

Every limit in fetchlet has an owner. Operational budgets belong to the
caller and live in configuration. Limits that come from a specification or
from the capacity of a type or dependency are fixed and documented with
their source.

## Caller budgets

Each `Limits` field is an `Option`. `Some(value)` enables the budget;
`None` leaves it to the host, and every field defaults to `None`. Choose
values by measuring the application's inputs, SSR output, upstream
services, concurrency and the process's total capacity.

| Field                     | Unit and scope                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`                 | Cooperative elapsed time of one app call, until its streaming body completes, or of a `FetchService` call from Rust                       |
| `request_body_bytes`      | Bytes of each incoming request body and each outbound request body; streams are checked against the declared length and the running total |
| `request_body_chunks`     | Chunks read from an outbound request body in JavaScript, empty chunks included                                                            |
| `response_body_bytes`     | Bytes of each outgoing response body and each upstream response body; declared length and running total                                   |
| `header_bytes`            | Total bytes of names and values in each header set                                                                                        |
| `url_bytes`               | Bytes of the incoming request URL and of each rewritten destination URL                                                                   |
| `bridge_message_bytes`    | Bytes of each JSON message to a native callback, and of each body buffer passed from JavaScript                                           |
| `digest_bytes`            | Bytes of input to one `crypto.subtle.digest` call, or to one `node:crypto` hash or HMAC                                                   |
| `rsa_modulus_bits`        | Modulus length of each RSA key `crypto.subtle.generateKey` creates, which bounds the time generation takes                                |
| `pbkdf2_iterations`       | Iterations of each PBKDF2 derivation in `crypto.subtle` or `node:crypto`                                                                  |
| `scrypt_memory_bytes`     | Working memory, 128 * r * (N + p + 2) bytes as OpenSSL counts it for `maxmem`, of each `node:crypto` scrypt derivation                    |
| `compression_streams`     | `CompressionStream` and `DecompressionStream` instances open at once in an invocation                                                     |
| `decompressed_bytes`      | Bytes one `DecompressionStream` produces, which bounds highly compressed input                                                            |
| `subrequests`             | Host fetches an invocation attempts to start; failed and aborted attempts still count                                                     |
| `redirects`               | Redirects one fetch follows, within the Fetch specification's limit                                                                       |
| `background_timeout`      | Cooperative elapsed time of `fetchlet.waitUntil` work, counted from the end of the result or body                                         |
| `background_tasks`        | `fetchlet.waitUntil` registrations per invocation, completed ones included                                                                |
| `channel_message_bytes`   | Bytes of one message on a channel, such as a server WebSocket, in either direction                                                        |
| `channel_buffer_bytes`    | Bytes queued on one channel in each direction: from Rust, unread by JavaScript; from JavaScript, unsent by Rust                           |
| `open_channels`           | Channels JavaScript opens from env bindings or with `connect()` in an invocation, refused opens included                                  |
| `connection_idle_timeout` | Time a held connection may pass without a message in either direction                                                                     |
| `connection_lifetime`     | Time a held connection may stay open after its upgrade                                                                                    |

`Some(0)` is a budget of zero; a zero `timeout` expires before the call
starts. A held connection's `timeout` covers the handler until it returns
the upgrade; the connection budgets apply after it. A message from Rust over
`channel_message_bytes` fails its send with `LimitExceeded`, and the sender
waits while `channel_buffer_bytes` is taken. A message from JavaScript over either budget closes
the channel with 1009, and an expired connection budget closes it with 1001.
A channel's stream view instead splits a write into messages within both
budgets and waits for room, so its writes never close the channel.
`Instances::max_held_connections` bounds the instances held by connections,
below the pool's `max`. The `limit` passed to `Body::collect(limit)` is also a caller
budget.

`WorkerOptions::response_body_queue` is how many chunks of a streaming body
the worker reads ahead from JavaScript. It defaults to one, so production
follows consumption. JavaScript merges up to 64 KiB of available chunks into
one pull; that is backpressure granularity, not a body budget.

The byte store and body sources belong to the invocation and are released
when it ends. Body sources are opened by Rust for the incoming request and
for host fetch responses, so their number follows `subrequests`. JavaScript
can leave at most one unclaimed buffer in the byte store at a time, so a
guest cannot accumulate memory outside the engine heap; buffers from Rust are
bounded by each body's budget. A compression codec takes more input only
after its output was read to the end, and output the guest did not take
before the next read is dropped and fails that read, so a codec holds at most
one write of input and one piece of output.

Output buffers whose size the guest chooses, such as derived keys, are
allocated fallibly: a size the process cannot allocate fails the operation
instead of aborting the process.

Body, header and message checks apply at each boundary. Copies made during
JSON conversion and buffering, and the engine's total heap, are managed
separately. JavaScript that never yields, and code running during
initialization, needs engine interrupts or an external process supervisor
to stop.

## Engine settings

| Setting                         | Owner and default                                                  |
| ------------------------------- | ------------------------------------------------------------------ |
| `QuickJsOptions` heap and stack | The caller; unset values keep QuickJS's own defaults (1 MiB stack) |
| `V8Options` worker stack        | The caller; unset keeps the platform's thread stack size           |
| `BoaOptions` value stack, calls | The caller; unset values keep Boa's own (10,240 slots, 512 calls)  |
| `WorkerOptions` stack           | The caller; unset keeps the platform's thread stack size           |

Explicit values must be positive. How well a setting is enforced depends on
the engine and operating system. A QuickJS stack limit must be smaller than
the native stack of the thread running it. `fetchlet_http::Server` sets a
64 MiB worker stack, a 4 MiB QuickJS limit and, on Boa, a recursion limit of
10,000 calls, because framework recursion in debug builds exceeds the
platform default and Boa's 512 calls stop ordinary code with an uncatchable
error. Boa's `JSON.stringify` recurses on the native stack without a depth
check, so deep enough data aborts the process instead of throwing.
examples/vinext-axum also raises Boa's value stack to 131,072 slots for
React Server Components rendering.

## Limits from specifications and capacity

| Limit                                 | Source and handling                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `getRandomValues` at 65,536 bytes     | The [Web Crypto quota](https://www.w3.org/TR/webcrypto-2/#Crypto-method-getRandomValues)                   |
| 20 redirects                          | The [Fetch HTTP-redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch); callers may set fewer |
| `node:crypto` key length, 2^31 - 1    | Node's `keylen` bound for `pbkdf2Sync` and `scryptSync`, checked by the host as well                       |
| `usize`, `u64` and clock ranges       | Checked arithmetic and validation of timeout configuration                                                 |
| `http::HeaderMap` and engine capacity | The dependency's capacity, turned into errors where the boundary allows                                    |

These have a different basis from operational budgets. Twenty redirects is
a compatibility condition of Fetch; the right number for an upstream API is
the caller's choice.

## Checks

Regression tests cover bodies larger than any former default, timeouts
longer than an hour, arbitrary message and subrequest budgets, redirects
that stop at the specification limit, and waking from pending futures. The
framework matrix runs Hono and SvelteKit with default engine settings.

Recommended production values will follow measurements of startup time,
RSS, latency and concurrency on the same application under the same load.

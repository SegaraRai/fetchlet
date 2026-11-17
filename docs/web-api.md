# Web API profile

Every engine runs the same Web API layer, the portable profile in
`fetchlet/runtime`. Engines differ in their native language features and
Intl support, which `fetchlet/build` fills per backend
([build](../packages/fetchlet/docs/build.md)). Host operations — fetch,
randomness, digests, URL parsing, the clock — go through Rust.

## Providers

The entry point is `packages/fetchlet/src/runtime/index.ts`; each API's
implementation is in `packages/fetchlet/src/runtime/web/`.

| Area                                                      | Provider                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| URL                                                       | Rust `url` crate (WHATWG URL Standard) through host operations |
| URLSearchParams, base64, structuredClone, DOMException    | core-js-pure                                                   |
| Streams                                                   | web-streams-polyfill, pinned                                   |
| Encoding                                                  | `@exodus/bytes` encoding-lite                                  |
| Random values, SHA-256                                    | Rust `getrandom` and `sha2` through host operations            |
| `performance.now`, `timeOrigin`                           | Rust's monotonic clock                                         |
| Fetch, Headers, Body, FormData, Blob, File, Abort, timers | fetchlet's own implementation                                  |

Native APIs that an engine already provides, such as V8's `TextEncoder`, are
kept.

## Coverage

| Area                | Behavior                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headers, Body       | Validation, record conversion, single consumption, byte-stream bodies with BYOB on all engines, `textStream`, clone with structuredClone, binary bodies, cookies             |
| Request             | Read-only attribute accessors (`mode`, `credentials`, `cache`, `referrer`, …) and RequestInit validation                                                                     |
| FormData, multipart | Repeated entries and File; byte-level multipart parsing with boundary rules, preamble and epilogue, quoted boundaries, UTF-8 and escapes, `TypeError` for malformed input    |
| Encoding            | UTF-8, UTF-16 and single-byte encodings, streaming and fatal modes, `TextEncoderStream`, `TextDecoderStream`                                                                 |
| Abort               | `AbortSignal.abort`, `timeout` and `any`, DOMException reasons, aborting body reads and host fetches                                                                         |
| Crypto              | Secure random values, UUID v4, SHA-256                                                                                                                                       |
| Timers and jobs     | Promises, `setTimeout` and `clearTimeout`, driven by host future notifications                                                                                               |
| fetch and env       | Async bridge to Rust services, origin policy, fixed bindings                                                                                                                 |
| Bodies, background  | Streaming response bodies, request and upstream bodies as `ReadableStream`, binary transfer through the byte store, `fetchlet.waitUntil`, timer cleanup at the end of a call |
| Execution control   | Optional cooperative deadline and engine options                                                                                                                             |

Request and Response bodies created from a string, BufferSource or
URLSearchParams stay as bytes until `body` is read. `arrayBuffer()`,
`bytes()`, `text()`, `json()`, `formData()` and `clone()` use those bytes
without creating a stream. A Fetch entry response that is still bytes goes
to the wire directly.

`globalThis.fetch` is writable, as WebIDL operations are. Next.js's fetch
cache replaces it; the replacement still calls the host fetch, and the
`FetchPolicy` still authorizes each send.

## Limits of the profile

- **No document base URL.** A server has no global base URL, so
  `new Request("")` and other relative URLs fail; adapters resolve them
  against the incoming request.
- **Legacy multi-byte encodings** (Shift_JIS, EUC-KR, …) are not included in
  encoding-lite.
- **SharedArrayBuffer** is not exposed by QuickJS and Boa.
- **Boa** gets ArrayBuffer `transfer`, `transferToFixedLength` and
  `detached` from the backend, because Boa 0.22 keeps them behind its
  `experimental` feature. Resizable buffers transfer as fixed-length.
- **Node APIs** are outside the profile. `fetchlet/build` provides
  `AsyncLocalStorage` for `node:async_hooks` (`asyncContext: "serialized"`),
  and the vinext adapter replaces the Node modules it needs.

[Conformance](conformance.md) lists every known difference with its reason.

## Verification

- 23 behavior probes ([fixtures/probe](../fixtures/probe/README.md)) run on
  each engine and on Node as a reference.
- Selected WPT, Test262 and regression tests run on each engine
  ([conformance](conformance.md)).
- The URL implementation runs the `url` crate's bundled WPT data
  (`vp run test:url`).
- Framework fixtures and examples exercise the profile under real
  applications.

Current numbers are in [reference](reference/README.md).
[Research](research/web-api-implementations.md) compares existing Web API
implementations for embedded engines.

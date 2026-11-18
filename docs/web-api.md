# Web API profile

Every engine runs the same Web API layer, the portable profile in
`fetchlet/runtime`. Engines differ in their native language features and
Intl support, which `fetchlet/build` fills per backend
([build](../packages/fetchlet/docs/build.md)). Host operations — fetch,
randomness, digests, URL parsing, the clock — go through Rust.

## Providers

The entry point is `packages/fetchlet/src/runtime/index.ts`; each API's
implementation is in `packages/fetchlet/src/runtime/web/`. Host operations
marked below are in the [fetchlet-web](../crates/fetchlet-web/README.md)
crate; the profile installs an API only when the host reports it.

| Area                                                      | Provider                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| URL                                                       | Rust `url` crate (WHATWG URL Standard) through host operations |
| URLSearchParams, base64, structuredClone, DOMException    | core-js-pure                                                   |
| Streams                                                   | web-streams-polyfill, pinned                                   |
| Encoding                                                  | `@exodus/bytes` encoding-lite                                  |
| URLPattern                                                | Rust `urlpattern` crate through host operations                |
| CompressionStream, DecompressionStream                    | Rust `flate2` and `brotli` through host operations             |
| Random values, SHA-256                                    | Rust `getrandom` and `sha2` through host operations            |
| `performance.now`, `timeOrigin`                           | Rust's monotonic clock                                         |
| Fetch, Headers, Body, FormData, Blob, File, Abort, timers | fetchlet's own implementation                                  |
| Event, CustomEvent, EventTarget, `navigator`, reportError | fetchlet's own implementation                                  |

Native APIs that an engine already provides, such as V8's `TextEncoder`, are
kept.

## Coverage

| Area                | Behavior                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headers, Body       | Validation, record conversion, single consumption, byte-stream bodies with BYOB on all engines, `textStream`, clone with structuredClone, binary bodies, cookies             |
| Request             | Read-only attribute accessors (`mode`, `credentials`, `cache`, `referrer`, …) and RequestInit validation                                                                     |
| FormData, multipart | Repeated entries and File; byte-level multipart parsing with boundary rules, preamble and epilogue, quoted boundaries, UTF-8 and escapes, `TypeError` for malformed input    |
| Encoding            | UTF-8, UTF-16 and single-byte encodings, streaming and fatal modes, `TextEncoderStream`, `TextDecoderStream`                                                                 |
| Events              | `Event`, `CustomEvent` and `EventTarget` with `once`, `passive`, `signal`, `handleEvent` objects and cancellation; dispatch reaches only the target, as there is no tree     |
| Abort               | `AbortSignal` is an `EventTarget`; `abort`, `timeout` and `any`, DOMException reasons, aborting body reads and host fetches                                                  |
| Crypto              | `getRandomValues`, UUID v4 and every `SubtleCrypto` method: SHA digests, HMAC, RSA, ECDSA, ECDH, Ed25519, X25519, AES, HKDF and PBKDF2; key material stays in the guest      |
| Compression         | Four formats over any BufferSource chunks; truncated, corrupt or trailing input errors the stream; the `decompressed_bytes` limit bounds the output                          |
| URLPattern          | Patterns, base URLs, `ignoreCase`, `test` and `exec`; component regular expressions run in the engine's own `RegExp`                                                         |
| Timers and jobs     | Promises, `setTimeout`, `setInterval` and their clear functions, driven by host future notifications                                                                         |
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

## WinterTC Minimum Common API

The [Minimum Common API](https://min-common-api.proposal.wintertc.org/)
(Ecma TC55) lists the interfaces and globals that server runtimes share.
fetchlet's status for each:

| Area                     | Status                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch, FormData          | `fetch`, `Headers`, `Request`, `Response`, `FormData`                                                                                                                |
| File API                 | `Blob`, `File`                                                                                                                                                       |
| Streams                  | All thirteen interfaces                                                                                                                                              |
| Encoding                 | `TextEncoder`, `TextDecoder`, `TextEncoderStream`, `TextDecoderStream`                                                                                               |
| URL                      | `URL`, `URLSearchParams`, `URLPattern`                                                                                                                               |
| DOM events and abort     | `Event`, `EventTarget`, `CustomEvent`, `AbortController`, `AbortSignal`                                                                                              |
| HTML events and messages | `ErrorEvent`, `PromiseRejectionEvent`, `MessageChannel`, `MessagePort` and `MessageEvent` are missing                                                                |
| WebIDL                   | `DOMException`                                                                                                                                                       |
| Compression              | `CompressionStream` and `DecompressionStream` with `gzip`, `deflate`, `deflate-raw` and `brotli`                                                                     |
| Web Crypto               | `Crypto`, `SubtleCrypto` and `CryptoKey` with the algorithms of the Web Cryptography API Level 2 and Ed25519 and X25519; `QuotaExceededError`                        |
| Performance              | `performance.now` and `timeOrigin`; the `Performance` interface is not exposed                                                                                       |
| WebAssembly              | Native on V8; QuickJS and Boa have none                                                                                                                              |
| Globals                  | `globalThis`, `self`, `atob`, `btoa`, `console`, `queueMicrotask`, `structuredClone`, timers, `navigator.userAgent` (`"fetchlet"`), `reportError`                    |
| Global events            | Missing: the global scope is not an `EventTarget`, so `onerror`, `onunhandledrejection` and `onrejectionhandled` have no events; `reportError` writes to the console |

[TODO](TODO.md#wintertc-gaps) tracks the missing parts.

## Limits of the profile

- **No document base URL.** A server has no global base URL, so
  `new Request("")` and other relative URLs fail; adapters resolve them
  against the incoming request.
- **Legacy multi-byte encodings** (Shift_JIS, EUC-KR, …) are not included in
  encoding-lite.
- **SharedArrayBuffer** is not exposed by QuickJS and Boa.
- **Boa** is built with its `annex-b` feature, so web-legacy built-ins
  such as `String.prototype.substr`, which libraries like `yaml` call, match
  QuickJS and V8.
- **Boa** gets ArrayBuffer `transfer`, `transferToFixedLength` and
  `detached` from the backend, because Boa 0.22 keeps them behind its
  `experimental` feature. Resizable buffers transfer as fixed-length.
- **Node APIs** are outside the profile. `fetchlet/build` provides
  `AsyncLocalStorage` for `node:async_hooks` (`asyncContext: "serialized"`),
  and the vinext adapter replaces the Node modules it needs.

[Conformance](conformance.md) lists every known difference with its reason.

## Verification

- 29 behavior probes ([fixtures/probe](../fixtures/probe/README.md)) run on
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

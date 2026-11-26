---
title: "Web API profile"
slug: docs/compatibility/web-api
description: "At-a-glance support matrix for Web APIs across QuickJS, Boa, and V8, plus engine differences and limits."
---

Every engine (QuickJS, Boa, and V8) runs the same portable Web API profile
installed by `fetchlet/runtime`, covering the
[WinterTC Minimum Common API](https://min-common-api.proposal.wintertc.org/)
plus fetchlet's runtime extensions. Native APIs that an engine already provides
(such as V8's `TextEncoder`) are kept.

## API support matrix

| Area | APIs | Status | Notes & limitations |
| ---- | ---- | ------ | ------------------- |
| **Fetch & HTTP** | `fetch`, `Headers`, `Request`, `Response`, `FormData` | Supported | Outbound `fetch()` requires Rust [`HostServices::outbound`](/docs/rust/host-services). No global base URL (relative URLs fail outside framework adapters). `globalThis.fetch` is writable, and replacements still enforce `FetchPolicy`. |
| **Streams** | `ReadableStream`, `WritableStream`, `TransformStream`, BYOB readers, queuing strategies (all 13 interfaces) | Supported | Incoming request bodies, outbound request bodies (`duplex: "half"`), and response bodies stream on demand. |
| **File & Blob** | `Blob`, `File` | Supported | `Blob.stream()` returns a byte stream on all engines. |
| **Encoding** | `TextEncoder`, `TextDecoder`, `TextEncoderStream`, `TextDecoderStream` | Partial | Supports UTF-8, UTF-16, and single-byte encodings (streaming + fatal modes). Legacy multi-byte encodings (Shift_JIS, EUC-KR, etc.) are not included. |
| **URL** | `URL`, `URLSearchParams`, `URLPattern` | Supported | `URL` and `URLPattern` run in Rust via `url` / `urlpattern` crates (`URL` falls back to `core-js` if the `url` Cargo feature is disabled). |
| **Compression** | `CompressionStream`, `DecompressionStream` | Supported | Supports `gzip`, `deflate`, `deflate-raw`, and `brotli` in Rust (`compression` Cargo feature). Output is bounded by `Limits::decompressed_bytes`. |
| **Web Crypto** | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle`, `CryptoKey` | Supported | Full Web Crypto Level 2 plus Ed25519 and X25519 (`web-crypto` Cargo feature). Key material stays in the guest; inputs are bounded by `Limits`. |
| **Events & Abort** | `Event`, `CustomEvent`, `EventTarget`, `AbortController`, `AbortSignal` | Supported | Includes `AbortSignal.abort`, `timeout`, and `any`. Request signals abort when the client disconnects ([cancellation](/docs/concepts/data-flow#cancellation-and-errors)). |
| **Global error events** | `ErrorEvent`, `PromiseRejectionEvent`, `reportError`, `onerror`, `onunhandledrejection`, `onrejectionhandled` | Supported | Global scope is an `EventTarget`. |
| **Messaging** | `MessageChannel`, `MessagePort`, `MessageEvent` | Partial | Works within a single instance using `structuredClone`; transferring ports is not supported. |
| **Timers** | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask` | Supported | Unfinished timers are discarded when an invocation ends unless kept alive by `waitUntil`. |
| **Performance** | `performance.now`, `timeOrigin`, `mark`, `measure`, `PerformanceEntry` | Partial | Entries reset at the end of each invocation. `PerformanceObserver` is not provided. |
| **Globals** | `globalThis`, `self`, `atob`, `btoa`, `console`, `structuredClone`, `DOMException`, `navigator.userAgent` (`"fetchlet"`) | Supported | `console.*` forwards to Rust's `HostServices::console` callback (discarded if unset). |
| **WebSockets (client)** | `WebSocket`, `CloseEvent` | Host opt-in | Requires Rust [`HostServices::websockets`](/docs/rust/host-services#client-websockets) and a `FetchPolicy`. |
| **WebSockets (server)** | `upgradeWebSocket(request)` (`fetchlet/runtime`) | Host opt-in | Requires `axum-websocket` / `actix-websocket` and `Instances::max_held_connections > 0`. |
| **TCP sockets** | `connect(address, options)` (`fetchlet/runtime`) | Host opt-in | WinterTC Sockets API (plain, TLS, STARTTLS). Requires Rust [`HostServices::sockets`](/docs/rust/host-services#sockets). |
| **Intl** | `Intl.DateTimeFormat`, `NumberFormat`, `PluralRules`, `Segmenter`, etc. | Engine / build | Native ICU on V8; polyfilled via FormatJS on QuickJS and Boa when declared in `requirements` / `intl` ([Building artifacts](/docs/javascript/build#choosing-a-backend-and-polyfills)). |
| **WebAssembly** | `WebAssembly` | V8 only | Native on V8; not available on QuickJS or Boa ([Engine limits](/docs/javascript/build#engine-limits)). |

## Engine differences

Most Web APIs behave identically across engines. The main differences are:

| Capability | QuickJS | Boa | V8 |
| ---------- | ------- | --- | -- |
| `WebAssembly` | Not available | Not available | Native |
| `Intl.Collator`, `Intl.supportedValuesOf` | Not available | Not available | Native |
| Other `Intl.*` APIs | FormatJS polyfill (opt-in) | FormatJS polyfill (opt-in) | Native ICU |
| `node:async_hooks` (`AsyncLocalStorage`) | `serialized` only | `serialized` or `propagated` | `serialized` or `propagated` |
| `Error.captureStackTrace` | Emulated (see [Globals](/docs/compatibility/node#globals)) | Emulated (see [Globals](/docs/compatibility/node#globals)) | Native |
| `ArrayBuffer.prototype.transfer` | Native | Provided by backend (fixed-length) | Native |
| Legacy Annex B built-ins (e.g. `substr`) | Native | Enabled (`annex-b`) | Native |

## Key behavioral details

- **No DOM or document base URL:** this is a server runtime, so `window`,
  `document`, and relative `new Request("/path")` calls without a base URL do
  not exist. Framework adapters resolve relative URLs against the incoming
  request.
- **Fast path for buffered bodies:** `Request` and `Response` bodies created
  from a string, `BufferSource`, or `URLSearchParams` stay as raw bytes until
  `.body` is accessed, avoiding stream overhead for common responses.
- **Host Web API features:** `URL`, `URLPattern`, compression streams, and Web
  Crypto are backed by Rust crates in `fetchlet-web` (all enabled by default via
  the `web-apis` Cargo feature). If a Cargo feature is disabled on the Rust
  host, the corresponding global is omitted at runtime.

## Backing implementations

| Area | Implementation |
| ---- | -------------- |
| `URL`, `URLPattern`, Compression, Web Crypto, monotonic clock | Rust host ([`fetchlet-web`](/docs/rust/fetchlet-web)): `url`, `urlpattern`, `flate2`, `brotli`, RustCrypto, `getrandom` |
| `URLSearchParams`, base64, `structuredClone`, `DOMException` | `core-js-pure` |
| Streams | `web-streams-polyfill` |
| Encoding | `@exodus/bytes` (`encoding-lite`) |
| Fetch, `Headers`, `Body`, `FormData`, `Blob`, `File`, Events, `AbortSignal`, Timers, `MessageChannel`, `Performance` | fetchlet (`@fetchlet/web`) |

For edge-case differences and WPT / Test262 conformance numbers, see
[conformance](https://github.com/SegaraRai/fetchlet/blob/main/docs/conformance.md)
and [reference](https://github.com/SegaraRai/fetchlet/blob/main/docs/reference/README.md)
in the repository.

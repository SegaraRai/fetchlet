---
title: "Node.js compatibility"
slug: docs/compatibility/node
description: "Which node:* modules and globals work in fetchlet, which are stubbed, and how they differ from Node.js."
---

fetchlet runs on the [Web API profile](/docs/compatibility/web-api), not
Node.js. Because web frameworks and npm packages frequently import `node:*`
modules, [`fetchlet/build`](/docs/javascript/build) automatically provides a
curated subset of Node.js built-ins (similar to Cloudflare Workers'
`nodejs_compat`).

**At a glance:**

- **Supported:** pure-JS and host-backed server utilities (`node:buffer`,
  `node:crypto`, `node:stream`, `node:zlib`, `node:events`, `node:util`,
  `node:path`, `node:url`, `node:timers`, `node:http` client, etc.).
- **Not supported (stubbed):** OS and process APIs (`node:fs`, `node:child_process`,
  `node:net`, `node:dns`, `node:os`, `node:worker_threads`, `node:cluster`,
  `http.createServer`). Use Rust [`HostServices`](/docs/rust/host-services) or
  [`fetchlet/runtime`](/docs/javascript/runtime) instead.

## Supported modules

Both `node:*` and bare specifiers (such as `crypto` or `buffer`) resolve to
fetchlet's implementations for the modules below.

| Module                                | Status      | What is provided & key differences                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:assert`, `node:assert/strict`   | Partial     | `ok`, `equal`, `strictEqual`, `deepEqual`, `deepStrictEqual` (+ negations), `throws`/`rejects`, `match`, `ifError`, `fail`, `AssertionError`. Brief error messages; no `partialDeepStrictEqual` or `Assert`.                                                                                                                                                                                                                                                                      |
| `node:async_hooks`                    | Opt-in      | `AsyncLocalStorage` and `AsyncResource` when `asyncContext` is `"serialized"` (all engines) or `"propagated"` (V8/Boa). Stubbed when `asyncContext` is unset. `createHook` / `executionAsyncId` are no-ops. See [Async context](/docs/javascript/build#async-context) for the QuickJS limitation and planned removal of `"serialized"`.                                                                                                                                           |
| `node:buffer`                         | Full        | `Buffer` (with `base64url`), `isUtf8`, `isAscii`, `constants`, `kMaxLength`, `atob`, `btoa`, `Blob`, `File`.                                                                                                                                                                                                                                                                                                                                                                      |
| `node:crypto`                         | Partial     | Backed by Rust (`fetchlet-web`): hashes (`MD5`, `SHA-1`, `SHA-2`), `HMAC`, `pbkdf2`/`hkdf`/`scrypt` (+ `Sync`), `timingSafeEqual`, random helpers, `webcrypto`/`subtle`, `KeyObject` (unencrypted PEM/DER/JWK), `generateKey`/`generateKeyPair`, `sign`/`verify` (RSA, ECDSA, Ed25519), `publicEncrypt`/`privateDecrypt` (RSA-OAEP), `diffieHellman` (ECDH, X25519), `createCipheriv`/`createDecipheriv` (AES-CBC/CTR/GCM). No encrypted PEM or `privateEncrypt`/`publicDecrypt`. |
| `node:diagnostics_channel`            | Full        | `channel`, `subscribe`, `unsubscribe`, `hasSubscribers`, `tracingChannel`, `bindStore`, `runStores`.                                                                                                                                                                                                                                                                                                                                                                              |
| `node:events`                         | Full        | `EventEmitter` (listener order, `once`, `error`/`errorMonitor`, max-listener warning), `on`, `getEventListeners`, `listenerCount`, `addAbortListener`.                                                                                                                                                                                                                                                                                                                            |
| `node:http`, `node:https`             | Client only | `request` and `get` implemented over `fetch` (`ClientRequest`, `IncomingMessage`, `Agent`, `STATUS_CODES`, `METHODS`). Buffers request body, no redirects, no `Agent` pooling. `createServer` throws.                                                                                                                                                                                                                                                                             |
| `node:path`, `node:path/posix`        | POSIX only  | Full POSIX implementation (`resolve` starts from `/`). No `win32` and no `matchesGlob`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `node:process`                        | Partial     | `EventEmitter` with `env` (`{ NODE_ENV: "production" }`), `nextTick` (microtask), `hrtime`, `cwd` (`"/"`), `uptime`, `stdout`/`stderr` → console. Ordinary `.env()` bindings stay out of `process.env`; use `HostServices::process_env(key, val)` in Rust to expose specific keys. `exit`/`abort`/`kill`/`chdir` throw.                                                                                                                                                           |
| `node:querystring`                    | Full        | `parse`, `stringify`, `escape`, `unescape`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `node:stream`, `node:stream/promises` | Full        | Node's `readable-stream` with `Readable`/`Writable`/`Duplex` `fromWeb`/`toWeb` and `duplexPair`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `node:stream/web`                     | Full        | Re-exports the profile's Web Streams, queuing strategies, and text/compression streams.                                                                                                                                                                                                                                                                                                                                                                                           |
| `node:string_decoder`                 | Full        | `StringDecoder` for UTF-8, UTF-16LE, Latin-1, ASCII, `base64`, `base64url`, and `hex`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `node:timers`, `node:timers/promises` | Partial     | `setTimeout`, `setInterval`, `setImmediate`, `scheduler.wait`/`yield` with `AbortSignal`. `ref()`/`unref()` are no-ops because timers end with the invocation.                                                                                                                                                                                                                                                                                                                    |
| `node:url`                            | Full        | `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL`, `urlToHttpOptions`, `domainToASCII`/`Unicode`, legacy `parse`/`format`/`resolve`.                                                                                                                                                                                                                                                                                                                                     |
| `node:util`, `node:util/types`        | Partial     | `promisify`, `callbackify`, `inherits`, `deprecate`, `format`, `inspect` (ignores `colors`/`showHidden`/`sorted`/`getters`), `isDeepStrictEqual`, `types`, `stripVTControlCharacters`, `toUSVString`, `TextEncoder`/`Decoder`. `debuglog` is a no-op.                                                                                                                                                                                                                             |
| `node:zlib`                           | Partial     | Backed by Rust (`compression` feature): gzip, deflate, raw deflate, Brotli (`Sync`, callback, stream), `unzip`, `crc32`, `constants`. Custom compression levels/dictionaries are ignored; decompressed output is identical.                                                                                                                                                                                                                                                       |

## Unsupported modules and alternatives

Any other Node.js built-in (unless an npm package of the same bare name is
installed) resolves to a **load-time stub**: imports, destructuring, and
subclassing succeed so libraries with unused Node code paths still load, but
calling any member throws `ERR_METHOD_NOT_IMPLEMENTED` (for example,
`node:fs.readFileSync is not available in fetchlet`).

| Unsupported module                                                     | Recommended alternative in fetchlet                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `node:fs`, `node:fs/promises`                                          | Expose file operations explicitly via Rust [Function bindings](/docs/rust/host-services#function-bindings) |
| `node:net`, `node:tls`                                                 | Use [`connect()`](/docs/javascript/runtime#tcp-sockets) from `fetchlet/runtime` with Rust `SocketService`  |
| `node:http` (`createServer`)                                           | Export a Fetch handler and serve it with [`fetchlet-http`](/docs/rust/fetchlet-http)                       |
| `node:child_process`, `node:os`, `node:worker_threads`, `node:cluster` | Run native or concurrent work in Rust and expose it through [Host services](/docs/rust/host-services)      |

Framework adapters may override specific modules when needed — for example,
[vinext](/docs/frameworks/vinext#node-apis) provides its own `node:fs`,
`node:path`, and `node:module`, and [Nitro](/docs/frameworks/nitro#output) uses
`unenv` for modules fetchlet does not implement.

## Globals

- **`Buffer`, `process`, `setImmediate`, `clearImmediate`** are injected into
  only the modules that reference them (zero bundle cost when unused) and are
  not attached to `globalThis`. `process.env.NODE_ENV` is inlined as
  `"production"` at build time without pulling in `node:process`.
- **Isomorphic library detection:** `process.version` is `""`, `process.versions`
  is empty, and `Object.prototype.toString.call(process)` is not
  `[object process]`, so libraries that branch between Node and Web APIs pick
  their Web path.
- **`Error.captureStackTrace` / `prepareStackTrace` / `stackTraceLimit`:**
  supported on all three engines (native on V8, emulated on QuickJS and Boa). On
  QuickJS and Boa, call sites omit receiver/type/method/constructor details and
  treat frames as top-level; on QuickJS, captured stacks omit the error header
  and keep all frames when the skip function is absent; on Boa,
  `prepareStackTrace` applies only to stacks captured via `captureStackTrace`.

## Runtime notes

- **Host-backed crypto and zlib:** `node:crypto` and `node:zlib` execute
  synchronously in Rust and respect `Limits::digest_bytes`,
  `pbkdf2_iterations`, `scrypt_memory_bytes`, `compression_streams`, and
  `decompressed_bytes` ([Resource limits](/docs/rust/resource-policy)). `scrypt`
  also enforces Node's default 32 MiB `maxmem`.
- **CommonJS & ESM:** `import` receives ES named exports; `require()` receives
  the module's default export matching Node's CommonJS shape (for example,
  `EventEmitter` for `events`).

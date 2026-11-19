# Node.js compatibility

Engines run the [Web API profile](web-api.md), not Node. Framework servers
and their dependencies still import Node's built-in modules, so
[`fetchlet/build`](../packages/fetchlet/docs/build.md) gives every artifact a
subset of them, implemented in [@fetchlet/node](../packages/node/README.md)
on top of the profile. Cloudflare Workers' `nodejs_compat` and Vercel's Edge
runtime set the precedent; the subset covers what the framework examples and
the libraries common in their servers reach.

## How modules resolve

| Import                                    | Result                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A module listed under [Modules](#modules) | fetchlet's module, with or without `node:`                                                         |
| Another built-in, bare (`punycode`)       | An npm package of that name when one is installed                                                  |
| Any other built-in                        | A stub that loads, and throws `ERR_METHOD_NOT_IMPLEMENTED` where a member is called or constructed |

- `import` gets the module's ES exports. `require` gets the module's default
  export, which holds every member as Node's CommonJS export does; for
  `events` that is the `EventEmitter` class.
- The stub keeps code that only references a module on paths it never takes
  loading: members can be read, destructured and extended at load time.
  Calling one throws, naming the member, such as
  `node:fs.readFileSync is not available in fetchlet`.
- Adapter plugins run first. vinext replaces `node:fs`, `node:path` and
  `node:module` with its own ([vinext](../packages/fetchlet/docs/vinext.md#node-apis)).
- Nitro's worker presets polyfill Node with unenv. The fetchlet preset keeps
  the modules above, and the globals below, for `fetchlet/build`; unenv
  provides the rest ([Nitro](../packages/fetchlet/docs/nitro.md#output)).

## Globals

`Buffer`, `process`, `setImmediate` and `clearImmediate` are imported into
each module that references them as free variables, so artifacts that never
use them carry none of their code. They are not properties of `globalThis`.
`process.env.NODE_ENV` is replaced with `"production"` at build time and does
not import `process`.

## Modules

| Module                                | Provided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:assert`, `node:assert/strict`   | `ok`, `equal`, `strictEqual`, `deepEqual`, `deepStrictEqual` and their negations with Node's comparison rules, `throws`, `doesNotThrow`, `rejects`, `doesNotReject`, `match`, `doesNotMatch`, `ifError`, `fail`, `strict` and `AssertionError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `node:async_hooks`                    | `AsyncLocalStorage` and `AsyncResource` for the build's `asyncContext` mode ([async context design](research/async-context.md)); `createHook` and `executionAsyncId` exist and track nothing. Without `asyncContext` the module is a stub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `node:buffer`                         | `Buffer` from buffer 6.0.3 with Node's `base64url` encoding added, `isUtf8`, `isAscii`, `constants`, `kMaxLength`, `atob`, `btoa`, `Blob` and `File`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `node:crypto`                         | `createHash`, `hash` and `getHashes` (MD5, SHA-1, SHA-224, SHA-256, SHA-384, SHA-512, SHA-512/224, SHA-512/256 and their OpenSSL aliases), `createHmac`, `pbkdf2`, `hkdf`, `scrypt` and their `Sync` forms, `timingSafeEqual`, the random functions, `webcrypto` and `subtle`; `KeyObject`, `createSecretKey`, `createPublicKey` and `createPrivateKey` from PEM, DER and JWK, `generateKeyPair` and `generateKey` and their `Sync` forms (RSA, EC P-256/384/521, Ed25519, X25519, HMAC, AES), `sign`, `verify`, `createSign` and `createVerify` (RSA PKCS #1 v1.5 and PSS, ECDSA, Ed25519), `publicEncrypt` and `privateDecrypt` (RSA-OAEP), `diffieHellman` (ECDH, X25519), and `createCipheriv` and `createDecipheriv` for AES-CBC, AES-CTR and AES-GCM |
| `node:diagnostics_channel`            | `channel`, `subscribe`, `unsubscribe`, `hasSubscribers`, `tracingChannel` with Node's events, and `bindStore` and `runStores`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `node:events`                         | `EventEmitter` with Node's listener order, `once` wrappers, `error` and `errorMonitor` events and the max-listener warning; `once`, `on`, `getEventListeners`, `getMaxListeners`, `setMaxListeners`, `listenerCount` and `addAbortListener`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `node:http`, `node:https`             | `request` and `get` over `fetch`, with `ClientRequest`, `IncomingMessage`, `Agent`, `globalAgent`, `STATUS_CODES`, `METHODS`, `validateHeaderName` and `validateHeaderValue`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `node:path`, `node:path/posix`        | Node's POSIX implementation; `resolve` starts from `/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `node:process`                        | An `EventEmitter` with `env`, `nextTick`, `hrtime`, `emitWarning`, `cwd`, `uptime`, `stdout` and `stderr` writing to the console; see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `node:querystring`                    | Node's `parse`, `stringify`, `escape` and `unescape`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `node:stream`, `node:stream/promises` | readable-stream 4.8, Node's own streams, with `Readable`, `Writable` and `Duplex` `fromWeb` and `toWeb` and `duplexPair`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `node:stream/web`                     | The profile's Web streams, queuing strategies and text and compression streams                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `node:string_decoder`                 | `StringDecoder` for UTF-8, UTF-16LE, Latin-1, ASCII, base64, base64url and hex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `node:timers`                         | `setTimeout`, `setInterval` and `setImmediate` returning `Timeout` and `Immediate` objects with `ref`, `unref`, `hasRef`, `refresh` and a numeric value; the `clear` functions accept the object or its number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `node:timers/promises`                | `setTimeout`, `setImmediate`, `setInterval` as an async iterator, and `scheduler.wait` and `scheduler.yield`, with `AbortSignal` support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `node:url`                            | `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL`, `urlToHttpOptions`, `domainToASCII`, `domainToUnicode`, and the legacy `parse`, `format`, `resolve` and `Url`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `node:util`                           | `promisify`, `callbackify`, `inherits`, `deprecate`, `format`, `formatWithOptions`, `inspect`, `isDeepStrictEqual`, `types`, `stripVTControlCharacters`, `toUSVString`, `debuglog`, `TextEncoder` and `TextDecoder`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `node:util/types`                     | The members of `util.types`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `node:zlib`                           | Gzip, deflate, raw deflate and Brotli in the `Sync`, callback and stream forms, `unzip`, `crc32` and `constants`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The tests in `packages/node` run each module beside Node's own and compare
the results (`vp run test:js`); the [runtime matrix](verification.md) checks
`node:crypto`, `node:zlib` and the other modules on QuickJS, Boa and V8
against Node.

## Differences from Node

- **Instance, not process.** `process.versions` is empty and
  `process.version` is `""`, and `Object.prototype.toString` does not report
  `[object process]`, so isomorphic libraries take their Web paths.
  `process.platform` is `"linux"`, `arch` `"x64"`, `pid` 1, `argv`
  `["fetchlet"]` and `env` `{ NODE_ENV: "production" }`; the Nitro preset adds
  the string bindings to `env`. `exit`, `abort`, `kill`, `chdir` and
  `binding` throw. `memoryUsage` and `cpuUsage` return zeros. `nextTick`
  queues a microtask, so ticks and promise reactions interleave in the order
  they were queued.
- **Timers.** An instance's event loop ends with its invocation, so `ref` and
  `unref` change nothing. `setImmediate` is a zero-delay timer.
- **node:crypto computes in the host.** Hashes, HMAC and the derivations call
  the `nodeCrypto.*` operations of
  [fetchlet-web](../crates/fetchlet-web/README.md) synchronously; the callback
  forms call back on a later microtask, after the work is done. A hash keeps
  its input until `digest` and hashes it in one call, which
  `Limits::digest_bytes` bounds, like `pbkdf2_iterations` and
  `scrypt_memory_bytes` ([resource policy](resource-policy.md)). scrypt also
  applies Node's own `maxmem`, 32 MiB by default.
- **Keys, signatures and ciphers use the host's Web Crypto.** They call the
  `crypto.*` operations synchronously, so they share Web Crypto's
  algorithms:
  - Signatures and OAEP hash with SHA-1, SHA-256, SHA-384 or SHA-512.
    `publicEncrypt` and `privateDecrypt` use OAEP only, and
    `privateEncrypt` and `publicDecrypt` throw.
  - Ciphers are AES-CBC, AES-CTR and AES-GCM. GCM returns its output from
    `final`, after the whole input; CBC and CTR return it from each `update`.
  - Keys load from unencrypted PEM and DER (SPKI, PKCS #1, PKCS #8, SEC 1,
    certificates) and JWK; encrypted PEM, other key types and
    `KeyObject.from` throw.
  - `getCiphers` and `getCurves` list what is provided.
- **zlib compresses in the host.** Each call runs one `compression.*` stream
  of [fetchlet-web](../crates/fetchlet-web/README.md), whose budgets bound the
  output. Levels, strategies, window sizes and dictionaries are accepted and
  ignored, so compressed bytes differ from Node's; decompressed bytes are the
  same. Stream objects pass each chunk to the host as it is written; `flush`
  and `params` only call back.
- **http has a client only.** `request` buffers the body and sends it with
  `fetch` at `end`, without following redirects. Sockets, `Agent` pooling
  and upgrade events do not exist, and `createServer` throws; the artifact's
  entry receives requests instead.
- **assert** compares as Node does, while its messages describe the values
  more briefly. `partialDeepStrictEqual` and `Assert` are not provided.
- **url.resolve** resolves with WHATWG rules, which agree with Node's legacy
  rules for hierarchical URLs; `pathToFileURL` resolves relative paths from
  `/`.
- **util.inspect** formats as Node does for primitives, plain objects,
  arrays (grouped into columns), class instances, `Map`, `Set`, typed
  arrays, `ArrayBuffer`, dates, regular expressions, errors, functions,
  classes, boxed primitives, circular references and custom inspection.
  It honors `depth` and `breakLength`; `colors`, `showHidden`, `sorted`,
  `getters` and `compact` are ignored, so `%o` formats like `%O` with a depth
  of 4. Proxies, promise states, getters' values and `WeakMap` contents are
  not shown.
- **path** has no `win32`, and `matchesGlob` throws.
- **util.debuglog** returns a function that logs nothing.

Other built-ins load as the stub above.
[Open work](TODO.md#framework-runtime-needs-beyond-wintertc) tracks what remains
for Node compatibility.

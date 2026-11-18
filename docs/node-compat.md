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
| Another built-in, bare (`string_decoder`) | An npm package of that name when one is installed                                                  |
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

| Module                         | Provided                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:async_hooks`             | `AsyncLocalStorage` and `AsyncResource` for the build's `asyncContext` mode ([async context design](research/async-context.md)); `createHook` and `executionAsyncId` exist and track nothing. Without `asyncContext` the module is a stub                                                                                          |
| `node:buffer`                  | `Buffer` from buffer 6.0.3 with Node's `base64url` encoding added, `isUtf8`, `isAscii`, `constants`, `kMaxLength`, `atob`, `btoa`, `Blob` and `File`                                                                                                                                                                               |
| `node:crypto`                  | `createHash`, `hash` and `getHashes` (MD5, SHA-1, SHA-224, SHA-256, SHA-384, SHA-512, SHA-512/224, SHA-512/256 and their OpenSSL aliases), `createHmac`, `pbkdf2`, `hkdf`, `scrypt` and their `Sync` forms, `timingSafeEqual`, `randomBytes`, `randomFill`, `randomInt`, `randomUUID`, `getRandomValues`, `webcrypto` and `subtle` |
| `node:events`                  | `EventEmitter` with Node's listener order, `once` wrappers, `error` and `errorMonitor` events and the max-listener warning; `once`, `on`, `getEventListeners`, `getMaxListeners`, `setMaxListeners`, `listenerCount` and `addAbortListener`                                                                                        |
| `node:path`, `node:path/posix` | Node's POSIX implementation; `resolve` starts from `/`                                                                                                                                                                                                                                                                             |
| `node:process`                 | An `EventEmitter` with `env`, `nextTick`, `hrtime`, `emitWarning`, `cwd`, `uptime`, `stdout` and `stderr` writing to the console; see below                                                                                                                                                                                        |
| `node:timers`                  | `setTimeout`, `setInterval` and `setImmediate` returning `Timeout` and `Immediate` objects with `ref`, `unref`, `hasRef`, `refresh` and a numeric value; the `clear` functions accept the object or its number                                                                                                                     |
| `node:timers/promises`         | `setTimeout`, `setImmediate`, `setInterval` as an async iterator, and `scheduler.wait` and `scheduler.yield`, with `AbortSignal` support                                                                                                                                                                                           |
| `node:util`                    | `promisify`, `callbackify`, `inherits`, `deprecate`, `format`, `formatWithOptions`, `inspect`, `isDeepStrictEqual`, `types`, `stripVTControlCharacters`, `toUSVString`, `debuglog`, `TextEncoder` and `TextDecoder`                                                                                                                |

The tests in `packages/node` run each module beside Node's own and compare
the results (`vp run test:js`); the [runtime matrix](verification.md) checks
`node:crypto` on QuickJS, Boa and V8 against Node.

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
  applies Node's own `maxmem`, 32 MiB by default. KeyObject, signatures,
  ciphers and key generation throw; `getCiphers` and `getCurves` return
  empty lists.
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

Modules that remain, and their order, are in [open work](TODO.md#framework-runtime-needs-beyond-wintertc).

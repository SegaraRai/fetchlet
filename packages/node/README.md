# @fetchlet/node

Node.js built-in modules for code that runs inside a fetchlet engine. They
build on the [Web API profile](../../docs/web-api.md) and, for cryptography
and compression, on the `nodeCrypto.*`, `crypto.*` and `compression.*` host
operations of [fetchlet-web](../../crates/fetchlet-web/README.md).
`node:stream` is [readable-stream](https://github.com/nodejs/readable-stream),
the port of Node's own streams.
[`fetchlet/build`](../../docs/build.md) resolves `node:*` imports to these
modules; see [Node.js compatibility](../../docs/node-compat.md) for what each
one covers.

| Subpath                                 | Module                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `@fetchlet/node/async-hooks`            | `node:async_hooks` over the engine's async context slot                 |
| `@fetchlet/node/async-hooks/serialized` | `node:async_hooks` for engines without the slot                         |
| `@fetchlet/node/assert`                 | `node:assert`                                                           |
| `@fetchlet/node/assert/strict`          | `node:assert/strict`                                                    |
| `@fetchlet/node/buffer`                 | `node:buffer`, with `Buffer` from the `buffer` package                  |
| `@fetchlet/node/crypto`                 | `node:crypto`: hashes, HMAC, derivations, keys, signatures, AES ciphers |
| `@fetchlet/node/diagnostics-channel`    | `node:diagnostics_channel`                                              |
| `@fetchlet/node/events`                 | `node:events`                                                           |
| `@fetchlet/node/http`                   | `node:http` client requests over fetch                                  |
| `@fetchlet/node/https`                  | `node:https` client requests over fetch                                 |
| `@fetchlet/node/path`                   | `node:path` with POSIX semantics                                        |
| `@fetchlet/node/process`                | `node:process`                                                          |
| `@fetchlet/node/querystring`            | `node:querystring`                                                      |
| `@fetchlet/node/stream`                 | `node:stream`, readable-stream with Web stream adapters                 |
| `@fetchlet/node/stream/promises`        | `node:stream/promises`                                                  |
| `@fetchlet/node/stream/web`             | `node:stream/web`                                                       |
| `@fetchlet/node/string-decoder`         | `node:string_decoder`                                                   |
| `@fetchlet/node/timers`                 | `node:timers`                                                           |
| `@fetchlet/node/timers/promises`        | `node:timers/promises`                                                  |
| `@fetchlet/node/url`                    | `node:url`                                                              |
| `@fetchlet/node/util`                   | `node:util`                                                             |
| `@fetchlet/node/util/types`             | `node:util/types`                                                       |
| `@fetchlet/node/zlib`                   | `node:zlib` over the host's compression                                 |

Each module's default export holds all of its members, so `require` of the
module returns the same object as Node's. The `events` default export is the
`EventEmitter` class with the module's functions as statics.

The package is private. [fetchlet](../fetchlet/README.md) lists it as a
development dependency, reexports its modules as `fetchlet/node/*` and
compiles them into its published output. Its peer dependencies are the ones
the compiled modules import, which `fetchlet` lists as dependencies.

The tests compare each module with Node's own. For `node:crypto` and
`node:zlib` they install a stand-in host whose operations Node computes; the
crate checks the real operations against published test vectors, and the
[runtime matrix](../../docs/verification.md) runs the modules on QuickJS, Boa
and V8 against Node.

# @fetchlet/node

Node.js built-in modules for code that runs inside a fetchlet engine. They
build on the [Web API profile](../../docs/web-api.md) and, for hashing and key
derivation, on the `nodeCrypto.*` host operations of
[fetchlet-web](../../crates/fetchlet-web/README.md).
[`fetchlet/build`](../../docs/build.md) resolves `node:*` imports to these
modules; see [Node.js compatibility](../../docs/node-compat.md) for what each
one covers.

| Subpath                                 | Module                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| `@fetchlet/node/async-hooks`            | `node:async_hooks` over the engine's async context slot          |
| `@fetchlet/node/async-hooks/serialized` | `node:async_hooks` for engines without the slot                  |
| `@fetchlet/node/buffer`                 | `node:buffer`, with `Buffer` from the `buffer` package           |
| `@fetchlet/node/crypto`                 | `node:crypto`: random values, hashes, HMAC, PBKDF2, HKDF, scrypt |
| `@fetchlet/node/events`                 | `node:events`                                                    |
| `@fetchlet/node/path`                   | `node:path` with POSIX semantics                                 |
| `@fetchlet/node/process`                | `node:process`                                                   |
| `@fetchlet/node/timers`                 | `node:timers`                                                    |
| `@fetchlet/node/timers/promises`        | `node:timers/promises`                                           |
| `@fetchlet/node/util`                   | `node:util`                                                      |

Each module's default export holds all of its members, so `require` of the
module returns the same object as Node's. The `events` default export is the
`EventEmitter` class with the module's functions as statics.

The package is private. [fetchlet](../fetchlet/README.md) lists it as a
development dependency, reexports its modules as `fetchlet/node/*` and
compiles them into its published output. Its peer dependencies are the ones
the compiled modules import, which `fetchlet` lists as dependencies.

The tests compare each module with Node's own. For `node:crypto` they install
a stand-in host whose operations Node computes; the crate checks the real
operations against published test vectors.

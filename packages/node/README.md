# @fetchlet/node

Node.js built-in module implementations (`node:buffer`, `node:crypto`,
`node:stream`, `node:zlib`, `node:events`, `node:http` client, `node:async_hooks`,
and more) for server-side JavaScript running inside a fetchlet engine.

> **Note:** Applications do not need to install `@fetchlet/node` directly. The
> [`fetchlet`](https://www.npmjs.com/package/fetchlet) package depends on it and
> resolves `node:*` imports to these modules automatically during bundling. Type
> your `node:*` imports with `@types/node` as usual.

## Subpaths

| Subpath                                      | Node.js module                                           |
| -------------------------------------------- | -------------------------------------------------------- |
| `@fetchlet/node/assert`, `/strict`           | `node:assert`, `node:assert/strict`                      |
| `@fetchlet/node/async-hooks`                 | `node:async_hooks` (`propagated` mode on V8 and Boa)     |
| `@fetchlet/node/async-hooks/serialized`      | `node:async_hooks` (`serialized` mode for all engines)   |
| `@fetchlet/node/buffer`                      | `node:buffer`                                            |
| `@fetchlet/node/crypto`                      | `node:crypto` (backed by Rust `fetchlet-web`)            |
| `@fetchlet/node/diagnostics-channel`         | `node:diagnostics_channel`                               |
| `@fetchlet/node/events`                      | `node:events`                                            |
| `@fetchlet/node/http`, `/https`              | `node:http`, `node:https` (client requests over `fetch`) |
| `@fetchlet/node/path`                        | `node:path` (POSIX)                                      |
| `@fetchlet/node/process`                     | `node:process`                                           |
| `@fetchlet/node/querystring`                 | `node:querystring`                                       |
| `@fetchlet/node/stream`, `/promises`, `/web` | `node:stream`, `node:stream/promises`, `node:stream/web` |
| `@fetchlet/node/string-decoder`              | `node:string_decoder`                                    |
| `@fetchlet/node/timers`, `/promises`         | `node:timers`, `node:timers/promises`                    |
| `@fetchlet/node/url`                         | `node:url`                                               |
| `@fetchlet/node/util`, `/types`              | `node:util`, `node:util/types`                           |
| `@fetchlet/node/zlib`                        | `node:zlib` (backed by Rust `fetchlet-web`)              |

## Documentation

See the full support matrix and differences from Node.js at
<https://fetchlet.roundtrip.dev/docs/compatibility/node>.

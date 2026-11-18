# @fetchlet/web

The Web API implementations that run inside a fetchlet engine: Fetch,
Headers, Body, Blob, FormData, Encoding, Events, Abort, Streams, timers,
Compression, URLPattern and Web Crypto. They call the host operations of the
[fetchlet-web](../../crates/fetchlet-web/README.md) crate and install each API
only when the host reports it ([Web API profile](../../docs/web-api.md)).

| Subpath              | Contents                                                      |
| -------------------- | ------------------------------------------------------------- |
| `@fetchlet/web`      | Installs the Web APIs on the global object                    |
| `@fetchlet/web/wire` | Converts `Request` and `Response` to and from the wire format |

The package is private. [fetchlet](../fetchlet/README.md) lists it as a
development dependency, reexports it as `fetchlet/runtime` and compiles it
into its published output. Its subpaths point at the TypeScript sources; to
publish it on its own, remove `private` and add a build that writes `dist/`,
as `fetchlet` does.

`PROTOCOL_VERSION` in `src/web-host.ts` matches the one in fetchlet-web's
dispatcher; bump both when an operation's name or message changes.

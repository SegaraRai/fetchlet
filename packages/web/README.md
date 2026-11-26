# @fetchlet/web

The Web API implementations that run inside a fetchlet engine: Fetch,
Headers, Body, Blob, FormData, Encoding, Events, Abort, Streams, timers,
Compression, URLPattern and Web Crypto. They call the host operations of the
[fetchlet-web](https://github.com/SegaraRai/fetchlet/blob/main/crates/fetchlet-web/README.md) crate and install each API
only when the host reports it ([Web API profile](https://github.com/SegaraRai/fetchlet/blob/main/docs/web-api.md)).

| Subpath                       | Contents                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| `@fetchlet/web`               | Installs the Web APIs on the global object                    |
| `@fetchlet/web/async-context` | `Variable` and `Snapshot` over the engine's async context     |
| `@fetchlet/web/capabilities`  | The host Web APIs each global needs, and the protocol version |
| `@fetchlet/web/gaps`          | The polyfills and engine-only APIs that fill an engine's gaps |
| `@fetchlet/web/wire`          | Converts `Request` and `Response` to and from the wire format |

Each subpath that runs in the engine is a file in `src/` that only imports
or re-exports. The implementations live in `src/internal/<area>/`, one
directory per concern (`fetch`, `dom`, `html`, `url`, `crypto`, `webidl` and
so on), with their unit tests beside them. `capabilities` and `gaps` are
declarations that `fetchlet/build` reads in Node to plan a bundle: which
host APIs a global needs, and how a missing API is polyfilled or why it
cannot be. The polyfill packages they name, the pinned FormatJS releases,
are dependencies of this package and resolve from it.

[fetchlet](https://github.com/SegaraRai/fetchlet/blob/main/packages/fetchlet/README.md) depends on the package and initializes it in
`fetchlet/runtime`, so applications get it through `fetchlet` and do not
install it themselves. In the workspace the subpaths point at the TypeScript
sources; `vp run @fetchlet/web#build` compiles them and their declarations
into `dist/`, which the published manifest (`publishConfig.exports`) names.

`@fetchlet/web/capabilities` exports `PROTOCOL_VERSION` and
`hostOperations`, the operations of each fetchlet-web API. Both are written,
with the host's copy, from
[crates/fetchlet-web/protocol.json](https://github.com/SegaraRai/fetchlet/blob/main/crates/fetchlet-web/protocol.json)
by `vp run build:protocol`; the package's tests check that the profile calls
only listed operations.

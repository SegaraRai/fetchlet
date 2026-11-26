# @fetchlet/web

Guest-side Web API implementations (`fetch`, `Headers`, `Request`, `Response`,
`Blob`, `File`, `FormData`, Streams, Encoding, Events, `AbortSignal`, timers,
`URL`, `URLPattern`, Compression Streams, and Web Crypto) for code running
inside a fetchlet JavaScript engine.

> **Note:** Applications do not need to install `@fetchlet/web` directly. The
> [`fetchlet`](https://www.npmjs.com/package/fetchlet) package depends on it and
> bundles it automatically through `fetchlet/runtime`.

## Subpaths

| Subpath                       | Contents                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| `@fetchlet/web`               | Installs the Web API profile on `globalThis`                   |
| `@fetchlet/web/async-context` | `Variable` and `Snapshot` over the engine's async context slot |
| `@fetchlet/web/capabilities`  | Host Web API capability declarations and protocol version      |
| `@fetchlet/web/gaps`          | Polyfill and engine-only API declarations used by the builder  |
| `@fetchlet/web/wire`          | Wire conversion between Web `Request`/`Response` and Rust      |

## Documentation

See the [Web API profile](https://fetchlet.roundtrip.dev/docs/compatibility/web-api)
and [fetchlet-web](https://fetchlet.roundtrip.dev/docs/rust/fetchlet-web) guides
at <https://fetchlet.roundtrip.dev/docs>.

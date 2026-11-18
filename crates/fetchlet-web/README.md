# fetchlet-web

Host implementations of Web APIs for fetchlet guests. The guest runtime
(`fetchlet/runtime`) calls them as host operations: a name, a JSON message
and byte-store handles. They depend on no JavaScript engine, so QuickJS, Boa
and V8 share one implementation of each API.

| Feature                 | API                                                     | Provider            |
| ----------------------- | ------------------------------------------------------- | ------------------- |
| (always)                | `URL` parsing and setters                               | `url`               |
| `url-pattern` (default) | `URLPattern`                                            | `urlpattern`        |
| `compression` (default) | `CompressionStream`, `DecompressionStream`              | `flate2`, `brotli`  |
| `crypto` (default)      | `crypto.getRandomValues`, `randomUUID`, SHA-256 digests | `getrandom`, `sha2` |

The `fetchlet` crate enables it with every engine and forwards the optional
APIs through its `url-pattern`, `compression` and `web-crypto` features
(`web-apis` enables all three).

## Embedding

`dispatch` runs an operation, or returns `None` for a name that is not a Web
API operation, so the embedder routes its own operations. Stateful APIs,
such as compression streams, keep their state in a `WebState` that the
embedder creates per invocation and drops when it ends. Binary data moves
through the embedder's byte store, which implements `ByteHandles`.

```rust,ignore
use fetchlet_web::{Invocation, WebLimits, WebState, dispatch};

let mut state = WebState::default();
let reply = dispatch(
    "compression.open",
    r#"["gzip", false]"#,
    &WebLimits::default(),
    Some(Invocation { state: &mut state, bytes: &mut byte_store }),
);
```

`web.capabilities` reports `PROTOCOL_VERSION` and the APIs of the build.
The guest runtime installs only those globals, and none when the protocol
version differs from its own.

`WebLimits` carries the caller budgets these operations enforce
(`digest_bytes`, `compression_streams`, `decompressed_bytes`). The embedder
owns their values; fetchlet takes them from its `Limits`
([resource policy](../../docs/resource-policy.md)).

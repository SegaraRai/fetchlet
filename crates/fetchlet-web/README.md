# fetchlet-web

Host implementations of Web APIs for fetchlet guests. The guest runtime
([`@fetchlet/web`](../../packages/web/README.md), installed by
`fetchlet/runtime`) calls them as host operations: a name, a JSON message
and byte-store handles. They depend on no JavaScript engine, so QuickJS, Boa
and V8 share one implementation of each API.

| Feature                 | API                                                     | Provider                       |
| ----------------------- | ------------------------------------------------------- | ------------------------------ |
| `compression` (default) | `CompressionStream`, `DecompressionStream`              | `flate2`, `brotli`             |
| `node-crypto` (default) | `node:crypto` hashes, HMAC, PBKDF2, HKDF and scrypt     | RustCrypto crates              |
| `url` (default)         | `URL` parsing and setters                               | `url`                          |
| `url-pattern` (default) | `URLPattern`                                            | `urlpattern`                   |
| `web-crypto` (default)  | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle` | RustCrypto crates, `getrandom` |

The `crypto.*` operations are stateless: the guest's `CryptoKey` holds the
key material (raw bytes for secret keys, SubjectPublicKeyInfo and PKCS #8 DER
for key pairs) and passes it with each call, so keys created while a module
is evaluated work like the others. The guest normalizes algorithms and checks
key usages and JWK members; the host converts formats and does the
cryptography. AES-GCM is implemented over `aes` and `ghash` so that any iv
length and every tag length the specification allows work.

The `nodeCrypto.*` operations serve [`node:crypto`](../../docs/node-compat.md):
`nodeCrypto.hash` and `nodeCrypto.hmac` for MD5, SHA-1 and the SHA-2
family including SHA-512/224 and SHA-512/256, with HMAC keys of any length,
and `nodeCrypto.pbkdf2`, `nodeCrypto.hkdf` and `nodeCrypto.scrypt`. Each
takes its whole input in one message and returns the result as base64.

The `fetchlet` crate enables it with every engine and forwards the
APIs through its `url`, `url-pattern`, `compression`, `web-crypto` and
`node-crypto` features (`web-apis` enables all five).

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

With the `compression` feature, `Decompressor` is the streaming decoder of
`DecompressionStream` for host code, such as fetchlet-net's HTTP client
decoding a `Content-Encoding`: each read returns at most 64 KiB, and the
decompressed bytes in all count toward the limit it is given.

`web.capabilities` reports `PROTOCOL_VERSION` and the APIs of the build.
The guest runtime installs only those globals, and none when the protocol
version differs from its own. The version and the operations of each API
are defined once in [protocol.json](protocol.json); `vp run build:protocol`
writes them to `src/protocol.rs` and to `@fetchlet/web`, refuses a change
to the operations that keeps the version, and `vp run check:generated` fails
when either copy is stale. The crate's tests check that `dispatch` serves
exactly the listed operations of each reported API.

`WebLimits` carries the caller budgets these operations enforce
(`digest_bytes`, `rsa_modulus_bits`, `pbkdf2_iterations`,
`scrypt_memory_bytes`, `compression_streams`, `decompressed_bytes`). The embedder
owns their values; fetchlet takes them from its `Limits`
([resource policy](../../docs/resource-policy.md)).

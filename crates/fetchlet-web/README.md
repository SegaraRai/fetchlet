# fetchlet-web

Host implementations of Web APIs for fetchlet guests. The guest runtime
([`@fetchlet/web`](https://github.com/SegaraRai/fetchlet/blob/main/packages/web/README.md), installed by
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

The `nodeCrypto.*` operations serve [`node:crypto`](https://fetchlet.roundtrip.dev/docs/compatibility/node):
`nodeCrypto.hash` and `nodeCrypto.hmac` for MD5, SHA-1 and the SHA-2
family including SHA-512/224 and SHA-512/256, with HMAC keys of any length,
and `nodeCrypto.pbkdf2`, `nodeCrypto.hkdf` and `nodeCrypto.scrypt`. Each
takes its whole input in one message and returns the result as base64.

The `fetchlet` crate enables it with every engine and forwards the
APIs through its `url`, `url-pattern`, `compression`, `web-crypto` and
`node-crypto` features (`web-apis` enables all five).

## Documentation

The guide to this crate is at <https://fetchlet.roundtrip.dev/docs/rust/fetchlet-web>, and its API reference
is on [docs.rs](https://docs.rs/fetchlet-web). The fetchlet documentation starts at
<https://fetchlet.roundtrip.dev/docs>.

A JavaScript application that installs the `fetchlet` npm package also has
this documentation as Markdown in `node_modules/fetchlet/docs/`, where coding
agents can read the version that the application uses
([Coding agents](https://fetchlet.roundtrip.dev/docs/agents)).

# fetchlet-web

Engine-independent Rust host implementations of Web APIs (`URL`, `URLPattern`,
compression streams, Web Crypto, and `node:crypto`) used by
[`fetchlet`](https://crates.io/crates/fetchlet).

> **Note:** Most applications do not need to depend on `fetchlet-web` directly.
> The `fetchlet` crate enables it automatically and exposes its APIs through the
> `web-apis`, `url`, `url-pattern`, `compression`, `web-crypto`, and
> `node-crypto` features. Use this crate directly only when embedding
> `@fetchlet/web` into a custom JavaScript host.

## Cargo features

| Feature                 | API                                                     | Backing crates          |
| ----------------------- | ------------------------------------------------------- | ----------------------- |
| `compression` (default) | `CompressionStream`, `DecompressionStream`              | `flate2`, `brotli`      |
| `node-crypto` (default) | `node:crypto` hashes, HMAC, PBKDF2, HKDF, and scrypt    | RustCrypto              |
| `url` (default)         | `URL` parsing and setters                               | `url`                   |
| `url-pattern` (default) | `URLPattern`                                            | `urlpattern`            |
| `web-crypto` (default)  | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle` | RustCrypto, `getrandom` |

## Documentation

- **Guide:** <https://fetchlet.roundtrip.dev/docs/rust/fetchlet-web>
- **API reference:** <https://docs.rs/fetchlet-web>
- **Full documentation:** <https://fetchlet.roundtrip.dev/docs>

---
title: "Web API host crate (fetchlet-web)"
slug: docs/rust/fetchlet-web
description: "Engine-independent Rust implementations of Web APIs used internally by fetchlet and available for custom runtimes."
---

`fetchlet-web` provides the engine-independent Rust implementations behind
fetchlet's Web APIs (URL parsing, `URLPattern`, compression streams, Web Crypto,
and `node:crypto`).

Most applications do **not** depend on `fetchlet-web` directly: the `fetchlet`
crate enables it automatically and exposes its APIs through Cargo features
(`web-apis`, `url`, `url-pattern`, `compression`, `web-crypto`, `node-crypto`).
Use this crate directly only if you are embedding the `@fetchlet/web` guest
runtime into your own JavaScript host.

## Cargo features

| Feature                 | API                                                     | Backing crates                 |
| ----------------------- | ------------------------------------------------------- | ------------------------------ |
| `compression` (default) | `CompressionStream`, `DecompressionStream`              | `flate2`, `brotli`             |
| `node-crypto` (default) | `node:crypto` hashes, HMAC, PBKDF2, HKDF, and scrypt    | RustCrypto                     |
| `url` (default)         | `URL` parsing and setters                               | `url`                          |
| `url-pattern` (default) | `URLPattern`                                            | `urlpattern`                   |
| `web-crypto` (default)  | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle` | RustCrypto, `getrandom`        |

## Dispatching operations in a custom host

`dispatch` executes a named host operation and returns `None` if the name is not
a Web API operation, letting your host route its own operations alongside it.
Stateful APIs (such as compression streams) store per-invocation state in
`WebState`, and binary payloads pass through your implementation of
`ByteHandles`:

```rust
use fetchlet_web::{Invocation, WebLimits, WebState, dispatch};

let mut state = WebState::default();
let reply = dispatch(
    "compression.open",
    r#"["gzip", false]"#,
    &WebLimits::default(),
    Some(Invocation { state: &mut state, bytes: &mut byte_store }),
);
```

- **`web.capabilities`** reports `PROTOCOL_VERSION` and the compiled feature
  set. The guest runtime installs only the globals your build advertises (and
  none if the protocol version mismatches).
- **`WebLimits`** configures caller budgets (`digest_bytes`, `rsa_modulus_bits`,
  `pbkdf2_iterations`, `scrypt_memory_bytes`, `compression_streams`,
  `decompressed_bytes`). `fetchlet` populates these from `Limits`
  ([Resource limits](/docs/rust/resource-policy)).
- **`Decompressor`** (with the `compression` feature) exposes the streaming
  decoder directly to Rust host code, yielding at most 64 KiB per read within a
  byte limit.
- **`crypto.*` operations** are stateless: key material stays on the guest
  `CryptoKey`, so keys created at module evaluation time work across
  invocations.

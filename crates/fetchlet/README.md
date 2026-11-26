# fetchlet

Calls JavaScript functions and Fetch handlers from Rust. Requests,
responses and named functions share one runtime on QuickJS, Boa or V8.

```sh
cargo add fetchlet
```

| Feature             | Adds                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `quickjs` (default) | `Backend::quickjs()`, `Backend::QuickJs(QuickJsOptions)`                                                  |
| `boa`               | `Backend::boa()`, `Backend::Boa(BoaOptions)`                                                              |
| `v8`                | `Backend::v8()`, `Backend::V8(V8Options)`                                                                 |
| `process`           | [Process isolation](https://fetchlet.roundtrip.dev/docs/rust/fetchlet#process-isolation) of each instance |

Several engine features can be enabled together. Without any, the host API
(`HostServices`, `FetchService`, `Body`, `Limits`) remains available.

`Backend::for_target(name)` selects the engine an artifact was built for,
from the `backend` that `fetchlet/build` records: `quickjs`, `boa`, `v8`, or
`portable`, which takes the first enabled of QuickJS, Boa and V8. When that
engine's feature is not enabled, it fails with an error naming the feature.
`with_default_quickjs_stack` and `with_default_boa_stack` set an engine's
stack limits (for Boa, the value stack and recursion limit) when the options
leave them unset.

Every engine includes the host implementations of [fetchlet-web](https://fetchlet.roundtrip.dev/docs/rust/fetchlet-web).
These features select its Web APIs; the guest runtime installs only the
globals of the enabled ones. Without `url`, the guest's `URL` uses core-js's
parser instead of the `url` crate.

| Feature              | Adds                                                    |
| -------------------- | ------------------------------------------------------- |
| `web-apis` (default) | All five below                                          |
| `url`                | `URL` parsing and setters in Rust                       |
| `url-pattern`        | `URLPattern`                                            |
| `compression`        | `CompressionStream`, `DecompressionStream`              |
| `web-crypto`         | `crypto.getRandomValues`, `randomUUID`, `crypto.subtle` |
| `node-crypto`        | `node:crypto` hashes, HMAC, PBKDF2, HKDF and scrypt     |

On Windows with MSVC, `v8` links V8's prebuilt library, which is compiled
against the static C runtime. Build the binary with the static runtime as
well, so that it contains one C runtime instead of two, in the binary's
`.cargo/config.toml`:

```toml
[target.'cfg(all(windows, target_env = "msvc"))']
rustflags = ["-C", "target-feature=+crt-static"]
```

Without it, the link warns `LNK4098: defaultlib 'libcmt.lib' conflicts with
use of other libs`.

## Documentation

The guide to this crate is at <https://fetchlet.roundtrip.dev/docs/rust/fetchlet>, and its API reference
is on [docs.rs](https://docs.rs/fetchlet). The fetchlet documentation starts at
<https://fetchlet.roundtrip.dev/docs>.

A JavaScript application that installs the `fetchlet` npm package also has
this documentation as Markdown in `node_modules/fetchlet/docs/`, where coding
agents can read the version that the application uses
([Coding agents](https://fetchlet.roundtrip.dev/docs/agents)).

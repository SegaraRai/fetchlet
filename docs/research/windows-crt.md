# Research: the C runtime on Windows

With the dynamic C runtime, Rust's default on Windows (MSVC), links that
include V8 warn
`LNK4098: defaultlib 'libcmt.lib' conflicts with use of other libs`. This
records where the warning comes from, what it means and the configuration
that removes it, which the repository now uses.

## Cause

Checked with rustc's link command for one test binary, rerun by hand,
because rustc does not show the linker's output by default, and with
`dumpbin /directives` on each native library:

| Library                             | Built by                      | C runtime it asks for         |
| ----------------------------------- | ----------------------------- | ----------------------------- |
| `rusty_v8.lib` (v8 150.4.0)         | denoland/rusty_v8, prebuilt   | `libcmt.lib`: static (`/MT`)  |
| `quickjs.lib` (rquickjs-sys 0.14.0) | the `cc` crate, with clang-cl | `msvcrt.lib`: dynamic (`/MD`) |
| `libring_core` (ring 0.17.14)       | the `cc` crate                | `msvcrt.lib`: dynamic         |
| Rust's standard library             | rustc                         | dynamic unless `crt-static`   |

| Link                              | LNK4098 |
| --------------------------------- | ------- |
| fetchlet with `quickjs` and `boa` | No      |
| fetchlet with `v8` only           | Yes     |
| fetchlet-http with all features   | Yes     |
| Every engine with `+crt-static`   | No      |

V8's prebuilt library is compiled against the static CRT, and the rest of
the binary against the dynamic one, so the binary carries both: V8's code
calls a statically linked copy of the C runtime, with its own heap and
state, and everything else calls `VCRUNTIME140.dll` and the Universal CRT.
v8's build script follows the `crt-static` target feature only for the C++
library (`libcpmt` or `msvcprt`); the archive itself is the same either way.
MSVC does not support mixing the two in one image. The engine tests pass in
the mixed build, but nothing guarantees that memory or C runtime state never
crosses between the two copies, and the configuration is untested upstream:
Deno builds every Windows target with `+crt-static`.

## With `+crt-static`

Building with `RUSTFLAGS="-C target-feature=+crt-static"` makes the `cc`
crate compile QuickJS and ring with `/MT` and links Rust's standard library
statically, so every part uses `libcmt.lib`:

- The link has no LNK4098.
- `stack_trace`, `v8_termination`, `async_context` and `heap` pass on all
  three engines.
- The binary no longer imports `VCRUNTIME140.dll` or the
  `api-ms-win-crt-*` DLLs, so it runs on Windows without the Visual C++
  Redistributable, which matters for distributing examples and Tauri apps.
- The feature changes every crate's compilation, so the first build after
  switching rebuilds everything.

## Configuration

The repository sets the static CRT for MSVC targets in
`.cargo/config.toml`, as Deno does:

```toml
[target.'cfg(all(windows, target_env = "msvc"))']
rustflags = ["-C", "target-feature=+crt-static"]
```

Checked with it:

- `vp run test:rust`, which covers every engine, fetchlet-http's
  integrations, fetchlet-net and the Tauri example's regression tests.
- The Tauri examples build, and their end-to-end checks pass. Their
  binaries link the static VC runtime and the Universal CRT as DLLs,
  because `tauri-build` applies `static_vcruntime` when Tauri's
  `build.windows.staticVCRuntime` is on, its default. Microsoft supports
  that pairing, and the Universal CRT is part of Windows 10 and later, so
  these binaries also run without the Visual C++ Redistributable.
- The fuzz targets are unchanged: cargo-fuzz sets `RUSTFLAGS`, which
  replaces the configuration's `rustflags`, so they keep the dynamic CRT
  that MSVC's AddressSanitizer runtime needs. Both pass `vp run test:fuzz`.

fetchlet's README tells Windows embedders that the `v8` feature needs
`+crt-static` in their own configuration, since a library crate cannot set
target features for the binary that links it.

Rejected: `/NODEFAULTLIB:libcmt.lib`, which silences the warning and keeps
V8's statically compiled objects against the dynamic CRT; and building V8
from source with `/MD`, which takes hours per build and leaves the prebuilt
archives unused.

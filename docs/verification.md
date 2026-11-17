# Verification

This page lists the test suites, what each one checks and where its results
go. The results themselves are rendered in [reference](reference/README.md)
from `results/`.

## Suites

| Command                            | Checks                                                                                                                                                    | Results                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `vp run check`                     | Types (root, tools, the `fetchlet` package, examples), formatting, generated reference                                                                    | —                                            |
| `vp run test:rust`                 | Rust unit and integration tests, all features and none, clippy, rustfmt                                                                                   | —                                            |
| `vp run test:matrix`               | Functions, Hono JSX, SvelteKit and the Web API probes on QuickJS, Boa, V8 and Node                                                                        | `runtime-matrix.json`, `web-api-*.json`      |
| `vp run test:host`                 | JavaScript fetch through mock transports on each engine: permissions, bodies, cookies, credentials, redirects, rewrites, env, services, abort, retirement | `host-matrix.json`                           |
| `vp run test:conformance`          | Selected WPT, Test262 and regression tests ([conformance](conformance.md))                                                                                | `conformance.json`                           |
| `vp run test:url`                  | The `url` crate's WPT data on each engine                                                                                                                 | `url-wpt.json`                               |
| `vp run test:polyfills`            | Intl polyfill selection, locales, time zones, V8 builds without FormatJS, capability mismatches                                                           | `polyfill-matrix.json`                       |
| `vp run test:build`                | `fetchlet/build`: entries, asset archives, async context                                                                                                  | —                                            |
| `vp run test:package`              | The packed `fetchlet` tarball installed in a separate project: exports, declarations, an artifact built and run                                           | —                                            |
| `vp run test:tools`                | The conformance runner's self-tests                                                                                                                       | —                                            |
| `vp run test:examples`             | Each example's HTTP and browser checks                                                                                                                    | `example-*.json`                             |
| `vp run test:fuzz`                 | AddressSanitizer fuzzing of the host fetch and bridge boundaries ([security](security.md#fuzzing))                                                        | `fuzz-smoke.json`                            |
| `vp run test:aot`, `test:aot-link` | Experimental AOT compilers and static linking ([research](research/native-aot.md))                                                                        | `aot-matrix.json`, `native-link-matrix.json` |
| `vp run bench`                     | Throughput of each example per engine                                                                                                                     | `bench.json`, `bench.md`                     |

`vp run verify` runs `check` and every regular `test:*` suite except fuzzing,
AOT and benchmarks.

## What the suites cover

**Library.** `crates/fetchlet/tests/` covers independent instances, state
reuse, export selection, binary and cookie conversion, cancellation, the
console sink, in-process routing, reentry, shared handles (cancelling
started calls, queue backpressure, shutdown) and streaming bodies, each on
all three engines.

**HTTP.** `crates/fetchlet-http/tests/contract/` runs one contract against
the Tower, hyper (loopback TCP), axum and actix layers on each engine:
public origin, headers, binary bodies, `Set-Cookie`, client address,
context, collected and streamed bodies, error detail and worker shutdown,
trusted Context, cancellation on disconnect and origin validation.
`tests/artifact.rs` and `tests/assets.rs` cover artifacts and asset
archives.

**Frameworks.** `fixtures/` holds the pinned Hono and SvelteKit builds that
the engine matrix runs. Each example has an end-to-end suite in its
`tests/` directory. The framework examples share ten checks in
`tools/examples/common-checks.ts` — SSR and escaping, the Rust service
binding, assets, JSON endpoints, client context, body budgets,
`waitUntil`, concurrent requests, hydration and navigation — and add their
own.

| Example                 | Framework versions                  | Notes                                            |
| ----------------------- | ----------------------------------- | ------------------------------------------------ |
| sveltekit-axum          | SvelteKit 3.2.0, Svelte 5.57.3      | In-process Rust API, form actions, `event.fetch` |
| sveltekit-axum-tauri    | SvelteKit 3.2.0, Tauri 2            | Embedded artifact, CLI server and desktop app    |
| astro-axum              | Astro 7.4.12, @astrojs/svelte 9.1.6 | FormatJS Intl on QuickJS, streaming uploads      |
| nuxt-axum               | Nuxt 4.6.4, nitropack 2.13.6        | Nitro preset                                     |
| react-router-axum       | React Router 8.5.1, React 19.3.1    | Streaming SSR of deferred data                   |
| honox-axum, honox-tauri | HonoX 0.1.62                        | Tauri commands calling bundle functions          |
| tanstack-start-axum     | TanStack Start 1.169.5              | `AsyncLocalStorage` from `fetchlet/build`        |
| solidstart-axum         | SolidStart 2.2.3                    | `AsyncLocalStorage` from `fetchlet/build`        |
| qwik-city-axum          | Qwik City 1.20.4                    | Resumable SSR                                    |
| waku-axum               | Waku 1.0.0-rc.5                     | React Server Components                          |
| vinext-axum             | vinext 1.4.6                        | Node module replacements, replaced `fetch`       |

## Environment

Results are recorded on Windows x64 with stable Rust, Node 26, the pnpm
and Vite+ versions the root manifest and CI pin, and Visual Studio with
LLVM. Fuzzing uses nightly Rust. Dependencies are pinned by
`Cargo.lock` and `pnpm-lock.yaml`. CI runs the regular suites on Windows and
Linux ([security](security.md#continuous-checks)).

```bash
vp install --frozen-lockfile
vp run check
vp run test:rust
vp run test:matrix
vp run test:host
vp run example:embed
```

Browser checks need Chromium: `vp run setup:browser`.

## Known build warnings

- On Windows, Rust builds set `CC` and `CXX` to clang-cl in-process;
  all-feature links still warn `LNK4098 libcmt.lib`. Sorting out the CRT
  configuration is release work.
- Bundling frameworks into an IIFE warns about upstream uses of
  `import.meta.dirname`.

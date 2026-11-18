# Project conventions

Work directly in `F:\Projects\fetchlet`.

## Rust

- Put each module with children in `name/mod.rs`.
- Keep `lib.rs` and `mod.rs` limited to module declarations and reexports.
- Keep modules private and expose public APIs through `pub use`.
- Put engine implementations and options under `crates/fetchlet/src/backend/<engine>/`.
- Put host implementations of Web APIs in `crates/fetchlet-web/`, one module and Cargo feature per optional API, independent of any engine. Bump `PROTOCOL_VERSION` with the copy in `packages/web/src/internal/runtime/web-host.ts` when an operation's name or message changes.
- Group implementation by responsibility. Use descriptive names and ordinary control flow.
- Put framework runners, mock transports and benchmark scaffolding under test or tool directories (`tools/<name>/` for repository tooling, `fixtures/` for shared test inputs).
- Give each production limit an explicit owner and rationale: caller policy, external specification, or underlying capacity. Put caller budgets in configuration.
- Preserve generic function calls alongside the primary Request → Response API.
- Verify ownership, cancellation and permission boundaries with meaningful regression tests and fuzzing.

## JavaScript and tooling

Use Vite+ with pnpm. Define tasks in `vite.config.ts`. Use `vp i` for dependencies and `vp run` for tasks.

- Name tasks by effect: `build:*` produces local outputs, `test:*` asserts behavior, `check:*` verifies static consistency, `fetch:*` restores pinned inputs, `refresh:*` updates them, and `setup:*` installs optional toolchains. `check` and `verify` aggregate with an empty command and `dependsOn`.
- Declare prerequisites such as `build:lab` and `build:fixtures` in `dependsOn`. Disable caching for tasks whose inputs Vite+ cannot track, such as Cargo builds, servers and browser runs.
- Write ESM only, in `"type": "module"` packages: use `.js` and `.d.ts`, not `.mjs`, `.cjs` or `.d.mts`. Generated files a tool writes outside such a package may keep `.mjs`.
- Write repository tooling in TypeScript that Node runs directly with type stripping: import files with their `.ts` extension and use erasable syntax only. Keep tools cross-platform; do not add shell or PowerShell scripts.
- Put each tool group in `tools/<name>/` as a private package `@fetchlet-internal/tools-<name>`, with flat files and no `src/`. Shared paths, process, Cargo and host protocol helpers live in `tools/workspace`; import them by package name.
- Resolve paths from the repository root exported by `tools/workspace/paths.ts`, not from the working directory. Run Cargo through `tools/workspace/cargo.ts` so the native compiler environment is consistent.
- Test JavaScript with Vitest through `vp test`, importing from `vite-plus/test`. Put unit tests next to their module as `*.test.ts` and broader suites in the package's `tests/`; each package with tests has a `vite.config.ts` with a `test` section, listed in the root `test.projects` unless it needs prerequisites such as `build:lab`.
- Write package sources, example scripts and tests in TypeScript too. Code that runs inside the engines as written, such as `crates/fetchlet/js/` and engine fixtures, stays JavaScript.
- When code needs another module of the package as a file, publish that module as a subpath and resolve it with `createRequire(import.meta.url).resolve`; do not build paths relative to `import.meta.url`.
- Publish JavaScript as the single npm package `fetchlet` (`packages/fetchlet`), with one subpath per framework and the integrations under `src/integrations/<framework>/`. Name private workspace packages `@fetchlet-internal/*`; keep `@fetchlet/*` for packages that could be published on their own.
- Put the guest Web API implementations in `@fetchlet/web` (`packages/web`), the counterpart of `crates/fetchlet-web`. It stays private with subpaths pointing at its TypeScript sources; `fetchlet` lists it as a development dependency and compiles it into its own output.

## Documentation

Describe the supported behavior, configuration and next work affirmatively. State material compatibility and security limitations precisely, with their scope and evidence. Keep implementation notes, user documentation and research results appropriate to their audience.

- Write documentation, comments, user-facing strings and sample content in English. Non-ASCII text belongs only in tests and fixtures that exercise Unicode handling.
- Keep `docs/README.md` as the index. Track next work in `docs/TODO.md`, and put investigations under `docs/research/`.
- `docs/reference/` is generated from `results/` by `vp run build:reference`; `check:generated` fails when it is stale. Do not edit it by hand.
- Results record what they were produced with (`environment()` in `tools/workspace/results.ts`: toolchain, engine and package versions), never when, and nothing else that varies between identical runs, such as durations or iteration counts. A rerun with the same versions and outcomes leaves the files unchanged. Measurements such as benchmarks go to the untracked `.cache/`.

## Workspace layout

- Put Rust libraries in `crates/<crate>/`, shared JS packages in `packages/<package>/`, and runnable applications in `examples/<framework>-<rust-server>/`.
- Keep framework adapters independent from Rust HTTP integrations.
- Give each example its own source, build output, run instructions and end-to-end checks.
- Verify browser hydration and assets along with SSR, endpoints and actions.
- Add framework examples as their actual supported profiles become usable.

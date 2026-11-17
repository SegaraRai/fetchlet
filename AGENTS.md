# Project conventions

Work directly in `F:\Projects\fetchlet`.

## Rust

- Put each module with children in `name/mod.rs`.
- Keep `lib.rs` and `mod.rs` limited to module declarations and reexports.
- Keep modules private and expose public APIs through `pub use`.
- Put engine implementations and options under `crates/fetchlet/src/backend/<engine>/`.
- Group implementation by responsibility. Use descriptive names and ordinary control flow.
- Put framework runners, mock transports and benchmark scaffolding under test or tool directories (`tools/<name>/` for repository tooling, `fixtures/` for shared test inputs).
- Give each production limit an explicit owner and rationale: caller policy, external specification, or underlying capacity. Put caller budgets in configuration.
- Preserve generic function calls alongside the primary Request → Response API.
- Verify ownership, cancellation and permission boundaries with meaningful regression tests and fuzzing.

## JavaScript and tooling

Use Vite+ with pnpm. Define tasks in `vite.config.ts`. Use `vp i` for dependencies and `vp run` for tasks.

- Name tasks by effect: `build:*` produces local outputs, `test:*` asserts behavior, `check:*` verifies static consistency, `fetch:*` restores pinned inputs, `refresh:*` updates them, and `setup:*` installs optional toolchains. `check` and `verify` aggregate with an empty command and `dependsOn`.
- Declare prerequisites such as `build:lab` and `build:fixtures` in `dependsOn`. Disable caching for tasks whose inputs Vite+ cannot track, such as Cargo builds, servers and browser runs.
- Write repository tooling in TypeScript that Node runs directly with type stripping: import files with their `.ts` extension and use erasable syntax only. Keep tools cross-platform; do not add shell or PowerShell scripts.
- Put each tool group in `tools/<name>/` as a private package `@fetchlet-internal/tools-<name>`, with flat files and no `src/`. Shared paths, process, Cargo and host protocol helpers live in `tools/workspace`; import them by package name.
- Resolve paths from the repository root exported by `tools/workspace/paths.ts`, not from the working directory. Run Cargo through `tools/workspace/cargo.ts` so the native compiler environment is consistent.
- Name private workspace packages `@fetchlet-internal/*`; `@fetchlet/*` is reserved for publishable packages.

## Documentation

Describe the supported behavior, configuration and next work affirmatively. State material compatibility and security limitations precisely, with their scope and evidence. Keep implementation notes, user documentation and research results appropriate to their audience.

## Workspace layout

- Put Rust libraries in `crates/<crate>/`, shared JS packages in `packages/<package>/`, and runnable applications in `examples/<framework>-<rust-server>/`.
- Keep framework adapters independent from Rust HTTP integrations.
- Give each example its own source, build output, run instructions and end-to-end checks.
- Verify browser hydration and assets along with SSR, endpoints and actions.
- Add framework examples as their actual supported profiles become usable.

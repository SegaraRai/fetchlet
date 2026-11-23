# Project conventions

Work directly in `F:\Projects\fetchlet`.

## Rust

- Put each module with children in `name/mod.rs`.
- Keep `lib.rs` and `mod.rs` limited to module declarations and reexports.
- Keep modules private and expose public APIs through `pub use`.
- Put engine implementations and options under `crates/fetchlet/src/backend/<engine>/`.
- Put host implementations of Web APIs in `crates/fetchlet-web/`, one module and Cargo feature per optional API, independent of any engine. Bump `PROTOCOL_VERSION` with the copy in `packages/web/src/capabilities.ts` when an operation's name or message changes.
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
- Write package sources, example scripts and tests in TypeScript too. Engine fixtures, which run inside the engines as written, stay JavaScript.
- Write the scripts a crate embeds in TypeScript under `crates/<crate>/js-src/`, type-checked by the crate's `tsconfig.json`. The crate's `vite.config.ts` compiles them with `vp pack` into the committed `js/`, which `include_str!` reads, so Cargo needs no JavaScript toolchain. Run `vp run build:scripts` after changing them; `check:generated` fails when the output is stale.
- Use `#` private members instead of TypeScript `private`. Keep `protected` only for members subclasses use.
- When code needs another module of the package as a file, publish that module as a subpath and resolve it with `createRequire(import.meta.url).resolve`; do not build paths relative to `import.meta.url`.
- Publish the user-facing JavaScript as the npm package `fetchlet` (`packages/fetchlet`), with one subpath per framework and the integrations under `src/integrations/<framework>/`. Name private workspace packages `@fetchlet-internal/*` and published supporting packages `@fetchlet/*`.
- Put the guest Web API implementations in `@fetchlet/web` (`packages/web`), the counterpart of `crates/fetchlet-web`, and the guest `node:*` modules in `@fetchlet/node` (`packages/node`). `fetchlet` depends on both and imports them by package name; it neither bundles their modules nor relays their subpaths. Each package's subpaths point at its TypeScript sources in the workspace, and `vp pack` compiles them to `dist/`, which `publishConfig.exports` names.

## Releases

- Release the npm packages under `packages/` and the published crates under one version ([docs/releasing.md](docs/releasing.md)). Record each user-observable change with `pnpm change`, naming the npm package or the crate placeholder `@fetchlet-crates/<crate>`.
- `crates/<crate>/package.json` is that placeholder: it holds the crate's version for pnpm change and is excluded from the crate package. Do not edit versions by hand; `pnpm version -r` and `tools/release/sync-version.ts` write them.
- A new published crate needs `publish = true`, an entry in `publishedCrates` (`tools/release/versioning.ts`), a placeholder and a place in `versioning.fixed`; `vp run check:release` verifies them.

## GitHub Actions

- Refer to each action by an exact version tag and update `.github/workflows/actions.lock` with `gh actions-lock` whenever a workflow or a `uses:` value changes.

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
- Keep an example's Rust and JavaScript sources in separate directories. When the framework's convention puts its sources in `src/`, put the Rust host in a directory named for its role, such as `server/` for an HTTP server or `cli/` for a command line program, and point Cargo at it with `[[bin]] path`.
- Verify browser hydration and assets along with SSR, endpoints and actions.
- Add framework examples as their actual supported profiles become usable.

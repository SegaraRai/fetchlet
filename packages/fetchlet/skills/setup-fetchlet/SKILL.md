---
name: setup-fetchlet
description: Add fetchlet to a JavaScript web application, build it into an artifact, and serve it from a Rust program, using the bundled documentation.
---

# Set up fetchlet

Use the documentation in `node_modules/fetchlet/docs/`. Without a local
package, use `../../docs/` relative to this skill's real directory, following
any link. If the skill was copied without the package, start from
https://fetchlet.roundtrip.dev/docs/llms.txt, which lists the Markdown version
of each page.

Read these pages before you change code:

- `docs/index.md`
- `docs/frameworks/index.md`, then the page of the project's framework
- `docs/javascript/dev.md`
- `docs/rust/fetchlet-http.md` when you add or change the Rust host

## Preflight checks

Inspect the project before editing files:

1. **Framework & version:** check `package.json` for the package manager,
   framework, and version. Confirm it is listed in `docs/frameworks/index.md`.
   If it is not, tell the user and offer `fetchlet/vite` (`docs/frameworks/vite.md`)
   or `fetchlet build` (`docs/javascript/build.md`).
2. **Engine choice (Wasm / Intl / Windows):** default to QuickJS (`quickjs`),
   unless the user asks for another engine OR `package.json` depends on
   WebAssembly-requiring packages (such as `shiki`, `satori`, `resvg`, `sql.js`,
   or `@electric-sql/pglite`). If WebAssembly is needed, recommend `v8` and
   explain why. When targeting `v8` on Windows MSVC, also add
   `rustflags = ["-C", "target-feature=+crt-static"]` in `.cargo/config.toml`
   (`docs/rust/fetchlet.md`).
3. **Rust host location:** look for an existing `Cargo.toml` (including
   workspace members in a monorepo). If none exists, ask the user whether to
   create one in the project root or a sibling directory.
   - **Avoid `src/` collisions:** if the JS app already uses `src/`, put the
     Rust host in `server/main.rs` (or `cli/main.rs` for a CLI) and point
     `Cargo.toml` at it with `[[bin]] name = "..." path = "server/main.rs"`.

## Steps

1. **Install `fetchlet`** as a development dependency using the project's
   package manager.
2. **Configure the framework adapter** as its page in `docs/frameworks/` shows,
   preserving existing framework options and noting the output directory
   (usually `build`):
   - **Astro** with Vite dev server: set `devServer: true` on `fetchletAdapter`.
   - **React Router** with Vite dev server: add `fetchletDevServer` in
     `vite.config.ts` alongside `reactRouter()`.
   - **Qwik City**: build uses two steps (`vite build && vite build --ssr`).
   - **vinext**: if the Rust host sets `Limits::background_tasks`, use at least
     `64` so route module preloads on the first request succeed.
3. **Build the artifact** and confirm the output directory contains
   `server.js`, `fetchlet.json`, and `client/` (or `assets.flpk` if
   `assets: true`).
4. **Configure the Rust host:**
   - Add `fetchlet` (default `quickjs`, or `--features boa` / `--features v8`)
     and `fetchlet-http --features axum` (plus `tokio` and `anyhow`).
   - **Keep dev features out of release builds:** define opt-in Cargo features
     in `Cargo.toml` rather than enabling them by default:
     ```toml
     [features]
     dev = ["fetchlet-http/dev-reload"]
     vite-dev = ["fetchlet-http/vite-dev"]
     ```
   - Prefer `fetchlet_http::Server::new("build")` for new hosts. For single
     binaries that embed the artifact in release builds while reloading from
     disk during development, use `Server::from_artifact(include_artifact!("../build")?).dev_directory("build")`.
   - **When integrating into an existing custom router (not `Server`):** use
     `artifact.app_builder()?` and `Artifact::default_worker_options()` so
     `artifact.requirements()`, safe stack/heap defaults (64 MiB worker stack,
     4 MiB QuickJS stack, Boa recursion/value-stack limits), and `host_runtime`
     are configured automatically. If using `ViteDev` manually, also set
     `CancelledCalls::Finish`.
   - If server code or dependencies read `process.env.KEY`, expose only the
     required keys explicitly in Rust with `HostServices::process_env(key, val)`
     instead of expecting host environment variables to leak automatically.
5. **Wire up the development script** in `package.json` using `fetchlet dev`
   (`docs/javascript/dev.md`):
   - For frameworks that support `--vite` (Astro, React Router, TanStack Start,
     Solid, SolidStart, Vite):
     `fetchlet dev --vite "vite dev" --watch-rust -- cargo run --features vite-dev`
     (use `"astro dev"` for Astro).
   - For other frameworks (SvelteKit, Nuxt/Nitro, Hono/HonoX, Qwik City,
     vinext, Waku):
     `fetchlet dev --watch-rust -- cargo run --features dev`.
6. **Connect request context & bindings** (`env`, `waitUntil`, `clientAddress`)
   using the framework's page and `fetchlet/bindings` module augmentation
   (`docs/javascript/runtime.md`).

## Verify

- Build the artifact, start the Rust host, and request a rendered page plus a
  static client asset to confirm both succeed without errors.
- If a Web or Node.js API fails at runtime, check
  `docs/compatibility/web-api.md` and `docs/compatibility/node.md` before
  adding polyfills or switching engines.

## Finish

- Offer to add the contents of `node_modules/fetchlet/AGENTS_TEMPLATE.md` to
  the project's instruction file (`AGENTS.md` or `CLAUDE.md`). Ask before
  creating or editing it, and preserve existing content.
- Mention that `docs/agents.md` explains how to install the bundled skills.
- Report the installed packages and crates, created/changed files, and
  verification results. Do not commit unless the user asks.

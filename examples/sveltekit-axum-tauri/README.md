# Markdown Workspace (SvelteKit + axum / Tauri)

`mdw` browses, searches and edits the Markdown notes in a folder. One Rust
binary is both a local web server for browsers (`mdw serve`) and a Tauri
desktop window (`mdw desktop`). The UI is SvelteKit, and fetchlet runs
SvelteKit's server side on QuickJS inside the Rust process.

```text
browser ──HTTP────────┐
                      ├─ axum Router ─┬─ /api/v1/*  Rust API (utoipa, OpenAPI)
Tauri webview ─URI scheme─┘           ├─ /files/*   workspace files
                                      ├─ assets     embedded asset archive
                                      └─ the rest   SvelteKit (fetchlet / QuickJS)
                                                      └─ fetch("https://fetchlet.internal/…")
                                                           → the same Rust API, in-process
```

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum-tauri#serve
```

```bash
vp run @fetchlet-internal/example-sveltekit-axum-tauri#desktop
```

`serve` opens a browser (`mdw serve --open`) and `desktop` opens a window.
The tasks copy `sample/` to `.cache/sveltekit-axum-tauri/notes` once and open
that folder, so edits do not change the repository; delete the copy to start
over.

A built `mdw` is used as follows:

```text
mdw serve [DIR] [--listen 127.0.0.1:4000] [--open]
mdw desktop [DIR]
mdw openapi [--output openapi.json]
mdw --config path/to/config.json …
```

Without `--config`, `mdw` reads `config.json` next to the executable, or
else this directory's `config.json`. `build.rs` embeds the SvelteKit build
(`server.js` and the Brotli `assets.flpk`) with `include_artifact!`, so
`build/` is not needed at run time. An `mdw` built before `vp run build`
has no embedded copy and serves the build named by `build_directory` in
the configuration; setting `build_directory` always replaces the embedded
copy.

## Develop

```bash
vp run @fetchlet-internal/example-sveltekit-axum-tauri#dev:serve
```

```bash
vp run @fetchlet-internal/example-sveltekit-axum-tauri#dev:desktop
```

The tasks build once and start `mdw serve --open` or `mdw desktop` with the
`dev` feature, which serves `build_directory` (`build/` by default) instead
of the embedded copy. Whenever a file in `web/` or `vite.config.ts`
changes, they run the `build` task again; fetchlet-http's `DevReload`
starts each new build. Browser pages reload through the script `DevService`
adds to them, and the desktop window is reloaded by `mdw` itself, since the
scheme's responses reach the webview whole. A failed build leaves the
previous one serving. Changes to the Rust sources need a restart.

## Features

| Feature                | Implementation                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Note tree and viewing  | Rust's index returns the list; SvelteKit renders HTML with unified, remark and rehype                                                      |
| Code highlighting      | During rendering, JavaScript sends every code block of a note to Rust's syntect in one in-process fetch                                    |
| Full-text search       | Rust's case-insensitive substring search, including Japanese; excerpts return matches as structured data                                   |
| Editing and preview    | A remote `command` renders the draft on the server; saving is a remote `form` (Ctrl+S also saves)                                          |
| Conflict detection     | The SHA-256 of the content is the version; a save from an outdated version is refused with 409, and the editor offers overwrite or discard |
| External changes       | `notify` updates the index; browsers learn about changes through Server-Sent Events, windows through a Tauri event                         |
| Creating and deleting  | Remote `form`s validated with valibot; an existing name is returned as a field error                                                       |
| Without JavaScript     | Viewing, search (a GET form) and creating notes work through SSR and form submissions                                                      |
| Images and other files | Served from `/files/<path>`; relative links and images in notes are rewritten to note pages and `/files`                                   |

## Shared types

The Rust handlers are the source of truth for the API types. utoipa
generates OpenAPI from the handlers and Serde types, and
[@hey-api/openapi-ts](https://heyapi.dev/) turns it into TypeScript types and
a fetch SDK.

```text
src/api/routes.rs ── mdw openapi ──▶ openapi.json ── openapi-ts ──▶ web/lib/api/ (types.gen.ts, sdk.gen.ts, client)
                                                                        │
web/lib/server/rust.ts (re-exports the SDK) ◀──────────────────────────┘
web/lib/notes.remote.ts (remote functions) ─▶ components
```

- Server-side JavaScript calls typed functions generated from utoipa's
  operation IDs, such as `rust.getNote({ query: { path } })`. `svelte-check`
  reports mismatched argument names, types or response shapes.
- The generated client uses `https://fetchlet.internal` as its base URL and
  has no runtime dependencies; see `openapi-ts.config.ts`.
- Remote functions carry the same types to browser components.
- After changing the API, regenerate both with
  `vp run --filter @fetchlet-internal/example-sveltekit-axum-tauri generate:api`.
  `cargo test` checks that the committed `openapi.json` matches the handlers.

The in-process API and the API `mdw serve` publishes at `/api/v1` are the
same axum router. In-process requests reach it through
`fetchlet_http::router_transport` without a socket. The fetch policy allows
only `https://fetchlet.internal`.

## Layout

| Path                      | Role                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- |
| `src/cli.rs`              | Subcommands (serve, desktop, openapi) and choosing the configuration file    |
| `src/host.rs`             | Workspace, watching, Rust API, starting fetchlet on each build; the router   |
| `src/serve.rs`            | `mdw serve`: listens with axum and checks the Host header                    |
| `src/desktop/`            | `mdw desktop`: URI scheme protocol, window, Tauri change events              |
| `src/api/`                | utoipa handlers, OpenAPI, syntect, file serving, Server-Sent Events          |
| `src/workspace/`          | Path validation, index, search, saving with optimistic concurrency, watching |
| `web/lib/notes.remote.ts` | Remote functions (query, command, form)                                      |
| `web/lib/server/`         | Markdown rendering and the typed Rust API client                             |
| `web/lib/api/`            | Types and SDK generated from OpenAPI (`openapi-ts.config.ts`)                |
| `openapi.json`            | The Rust API's OpenAPI document (generated, committed)                       |
| `config.json`             | Listen address, queue, body, note, file and index budgets, watch delay       |
| `sample/`                 | Demo notes                                                                   |
| `tests/e2e.test.ts`       | Checks `mdw serve` over real HTTP with Chromium                              |
| `tests/desktop.test.ts`   | Checks `mdw desktop` through WebView2's DevTools protocol                    |

## SvelteKit configuration

`compilerOptions.experimental.async` enables `await` in components and
`experimental.remoteFunctions` enables remote functions. The adapter uses
`rendering: "async"`, which replaces `node:async_hooks` with a
per-invocation `AsyncLocalStorage` ([SvelteKit
adapter](../../packages/fetchlet/docs/sveltekit.md)). Both features are
experimental in SvelteKit and Svelte.

## Why Rust highlights code

Running Shiki's JavaScript regex engine on QuickJS failed with
`too many captures`: after conversion, its grammars' regular expressions
exceed QuickJS's limit of 255 captures. The same bundle runs on V8. This example defaults to QuickJS and leaves highlighting to
Rust's syntect (two-face, with bat's grammars), called from rendering
JavaScript through a typed in-process fetch. It also shows JavaScript
Markdown processing and native Rust processing combined in one render.
Rendering a note with remark takes a few milliseconds on QuickJS.

## Authority and safety

- Paths the API accepts are plain `/`-separated segments. `..`, absolute
  paths, drive names, hidden files, trailing dots and spaces that alias on
  Windows, and device names are refused (`src/workspace/path.rs`).
- Before reading or writing, the canonical path must lie inside the
  workspace; symbolic links pointing outside are not followed, nor does the
  index follow links. Saves write a temporary file in the same directory and
  rename it.
- Raw HTML in notes is removed when rendering. `/files` responses carry
  `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`,
  so SVG and similar files cannot run scripts.
- `mdw serve` answers only requests whose Host header matches the listen
  address (others get 421), so a site that points DNS at 127.0.0.1 cannot
  read notes. The public API uses `application/json` bodies, PUT and DELETE
  and returns no CORS headers, so pages of other origins cannot send to it.
  SvelteKit forms go through SvelteKit's origin check.
- `mdw serve` is for a single local user and has no authentication; do not
  expose it with `--listen`.
- `cargo test -p example-sveltekit-axum-tauri` (paths, links, budgets,
  conflicts) and the end-to-end checks (API, `/files`, Host header, raw
  HTML) verify these boundaries. The symbolic link tests are skipped on
  Windows without developer mode or administrator rights.

## Budgets

The `config.json` values are this example's choices for a single-user local
note app.

| Field                   | Default | Meaning                                                                       |
| ----------------------- | ------- | ----------------------------------------------------------------------------- |
| `note_bytes`            | 1 MiB   | Largest note read, written or indexed; larger notes are left out of the index |
| `workspace_notes`       | 10,000  | Most notes indexed; more fails at startup                                     |
| `file_bytes`            | 16 MiB  | Largest file served from `/files`                                             |
| `request_body_bytes`    | 2 MiB   | Request bodies SvelteKit receives, including saved notes                      |
| `response_body_bytes`   | 32 MiB  | Largest response the desktop protocol returns to the webview                  |
| `invocation_timeout_ms` | 10 s    | Cooperative deadline of one request's JavaScript                              |
| `watch_debounce_ms`     | 150 ms  | Delay that merges file changes into one rescan                                |

Rust API request bodies may be up to twice `note_bytes` (a note body with
JSON escaping). Search returns at most 50 results per call (20 by default),
enough for the search page and suggestions.

## Desktop

`mdw desktop` starts no HTTP server. Tauri's custom URI scheme `mdw` passes
webview requests to the same axum router as `mdw serve`, in-process. Pages
load from `http://mdw.localhost/` on Windows (WebView2) and Android and
`mdw://localhost/` elsewhere; the app receives `http://mdw.localhost` URLs on
every platform.

- Tauri's `UriSchemeResponder` takes a complete body, so responses are
  collected within `response_body_bytes` first. Instead of Server-Sent
  Events, changes arrive as the Tauri event `workspace-changed`.
- `cargo build --no-default-features` leaves out the `desktop` feature and
  builds a CLI-only `mdw` that needs no webview library.
- The binary is a console application, so starting it from Explorer on
  Windows also opens a console.
- Automated checks run on Windows (WebView2). macOS (WKWebView) and Linux
  (WebKitGTK) are not built or verified.

## Server logs

`HostServices::console` forwards SvelteKit's `console.error` and other
console output to stderr as `[js Error] …` ([host
services](../../docs/host-services.md#console)).

## Checks

```bash
vp run setup:browser
vp run test:examples -- sveltekit-axum-tauri
```

The task builds the frontend and Rust, then runs `tests/e2e.test.ts` and
`tests/desktop.test.ts`.

- `e2e.ts`: Brotli serving and ETags of the embedded assets, SSR,
  highlighting in Rust, raw HTML removal, the public API, 409 on conflicts,
  refusing paths outside the workspace, the `/files` sandbox, the Host
  header, hydration with search suggestions and client navigation, editor
  preview and saving with Ctrl+S, external changes, editor conflicts and
  overwriting, creating notes with a remote form and its validation, and
  search and viewing without JavaScript. Results go to
  `results/example-sveltekit-axum-tauri.json`.
- `desktop.ts` (Windows only): rendering over the URI scheme, in-process
  highlighting, the workspace boundary, change notification through a Tauri
  event, and saving through the protocol. Results go to
  `results/example-sveltekit-axum-tauri-desktop.json`.

`cargo test -p example-sveltekit-axum-tauri` checks path validation, search
and excerpts, the index, concurrency control on save, budgets, symbolic
links, syntect and that the OpenAPI document matches.

## Next work

- Compile configuration defaults into the executable so `mdw` can ship
  alone.
- A Tauri installer (`tauri build`) and a folder picker.
- A persistent search index for large workspaces.
- Change notification through remote functions' `query.live`, once fetchlet
  streams those responses.

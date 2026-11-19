# HonoX + Tauri

Serves HonoX SSR, island assets and API routes to a Tauri 2 webview without
an HTTP server. Rust holds fetchlet's `AppHandle`, and Tauri's custom URI
scheme (`fetchlet`) turns webview requests into responses in-process. Tauri
commands call JavaScript functions of the server bundle with
`AppHandle::call`.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-honox-tauri#app
```

The task builds twice, the client (`--mode client`) and the server, then
starts the Tauri app on QuickJS with `cargo run` (the Tauri CLI is not
used).

## Develop

```bash
vp run @fetchlet-internal/example-honox-tauri#dev
```

The task builds once and starts the app with the `dev` feature. Whenever a
file in `app/`, `public/` or `vite.config.ts` changes, it runs the `build`
task again; fetchlet-http's `DevReload` starts each new build, the protocol
and the `greet` command use it from the next request, and the app reloads
the window. The scheme's responses reach the webview whole, so the app
reloads the window itself rather than through a script in the page. A
failed build leaves the previous one serving. Changes to the Rust sources
need a restart.

## Layout

| Path                      | Role                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `app/`                    | Routes, islands, renderer, API routes                                           |
| `app/functions.ts`        | JavaScript functions Rust calls (`greet`)                                       |
| `vite.config.ts`          | HonoX and fetchlet Vite plugins, Vite+ tasks                                    |
| `src/protocol.rs`         | The URI scheme protocol: Rust routes, then `client/` files, then fetchlet       |
| `src/frontend.rs`         | Starts fetchlet on the build, or on each build with the `dev` feature           |
| `src/commands.rs`         | The Tauri command `greet`                                                       |
| `src/desktop.rs`          | Assembles Tauri, reloads the window on a new build, shuts down on exit          |
| `config.json`             | Queue, body and response budgets, deadline, background budgets, stacks, backend |
| `tauri.conf.json`         | Tauri configuration; the window is created in `src/desktop.rs`                  |
| `capabilities/`, `icons/` | Tauri capabilities and icons                                                    |
| `tests/e2e.test.ts`       | Checks that drive WebView2 through the DevTools protocol                        |
| `build/`                  | `server.js`, `client/`, `fetchlet.json`                                         |

## Flow

1. `src/frontend.rs` opens the artifact in `build/` and starts fetchlet's
   worker with `App::builder(...).spawn(...)`.
2. `register_asynchronous_uri_scheme_protocol("fetchlet", ...)` passes
   webview requests to `Protocol::respond`.
3. `Protocol` answers `/api/rust` in Rust, serves `build/client` files with
   tower-http's `ServeDir`, and passes everything else to HonoX through
   [fetchlet-http](../../crates/fetchlet-http/README.md)'s `FetchletService`.
   It does not depend on axum.
4. The `greeter` island calls `invoke("greet")` from `@tauri-apps/api`, and
   the command runs `greet` from `app/functions.ts` with
   `AppHandle::call("greet", ...)`.

`functions` is a setting of [fetchlet/hono](../../packages/fetchlet/docs/hono.md)
that writes the named exports of the given modules into `server.js` next to
the Fetch handler `handle`. The command names the export it calls, so the
webview cannot call `handle` or other exports.

## Origin and URLs

The webview loads `http://fetchlet.localhost/` on Windows (WebView2) and
Android and `fetchlet://localhost/` elsewhere. The app receives
`http://fetchlet.localhost` plus the path and query on every platform (the
public origin of `FetchletService`). Tauri treats pages of registered URI
schemes as local, so they can use Tauri IPC.

## Switching backends

```bash
FETCHLET_BACKEND=v8 vp run --filter @fetchlet-internal/example-honox-tauri build
```

```bash
node tools/workspace/cargo.ts run -p example-honox-tauri --features v8
```

`FETCHLET_BACKEND` (`quickjs`, `boa` or `v8`) decides the artifact's backend,
and `"backend"` in `config.json` selects the Rust `Backend`. An app built
without the feature refuses a Boa or V8 configuration at startup. The
end-to-end checks set the configuration's backend to match
`FETCHLET_BACKEND` and pass on QuickJS, Boa and V8.

## Limitations

- Responses are returned whole. Tauri's `UriSchemeResponder` takes a
  complete body, so fetchlet's streamed response is collected within
  `response_body_bytes` (16 MiB) and a larger one becomes 502. The budget is
  a caller choice in `config.json`.
- The webview collects request bodies before passing them on.
  `FetchletService` accepts them within `request_body_bytes` and answers
  413 above it. Arrival-order streaming uploads, as in the axum examples,
  are not available.
- There is no client address; `clientAddress` is absent from
  `/api/context`.
- `csp` in `tauri.conf.json` is null. Tauri injects CSP for its built-in
  asset protocol, not for this scheme; set CSP in the application's
  response headers when needed.
- `build/` is read relative to `config.json`. Installers built with
  `tauri build` and bundling the build as a resource are open work.
- Automated checks run on Windows (WebView2). macOS (WKWebView) and Linux
  (WebKitGTK) are not built or verified; Linux builds need WebKitGTK and
  Tauri's other prerequisites.
- Release builds on Windows open no console, so `FETCHLET_TAURI_READY` on
  stdout and error output are not shown.

## Checks

```bash
vp run test:examples -- honox-tauri
```

The task builds the frontend and the app, starts the app with
`FETCHLET_DEVTOOLS_PORT=<port>`, which opens WebView2's DevTools protocol on
that port, and connects with Playwright's `connectOverCDP`. Every request comes from inside
the webview, so it goes through the URI scheme protocol. The checks cover
SSR and escaping, the Rust service binding, JavaScript, CSS and public files
and the refusal of files outside `client/`, JSON endpoints, context without
a client address, the protocol's Rust route, body budgets, `waitUntil`,
concurrent requests, hydration, calling a JavaScript function from a
command, and navigation. Results go to `results/example-honox-tauri.json`.
The checks are skipped outside Windows.

`cargo test -p example-honox-tauri` checks `Protocol` without a webview:
`client/` files and rendering at the public origin, refusing `..` reads
outside `client/`, and the request and response body budgets. It is part of
`vp run test:rust`.

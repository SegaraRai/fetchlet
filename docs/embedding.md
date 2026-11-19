# Embedding and distribution

fetchlet's target is a Rust program that ships a JavaScript framework's
server side inside itself: one binary for a CLI with a web UI, a local tool,
a self-hosted application or a Tauri desktop app. This page describes how an
artifact gets into such a program and how a host connects it to its own
lifecycle.

## What a binary contains

| Part          | Source                                                    | How it is loaded                         |
| ------------- | --------------------------------------------------------- | ---------------------------------------- |
| Engine        | The `fetchlet` crate's `quickjs`, `boa` or `v8` feature   | Linked into the binary                   |
| Server bundle | `server.js` from `fetchlet/build`                         | `Module::new(source)`                    |
| Manifest      | `fetchlet.json`: handler, functions, backend, assets      | `Artifact::handler()`                    |
| Client assets | `assets.flpk`, a Brotli [asset archive](asset-archive.md) | `AssetArchive`, served by `AssetService` |

`fetchlet_http::include_artifact!(dir)` embeds `fetchlet.json`, `server.js`
and `assets.flpk` from a build directory and returns an `Artifact`;
`Artifact::open(dir)` reads the same files at run time. Either one feeds
`artifact_router` or `AssetService`, so a program can embed its build for
release and read a directory during development.
examples/sveltekit-axum-tauri does both: `build.rs` embeds the build, and a
`build_directory` in the configuration replaces the embedded copy.

## Connecting to Rust

The main direction is Rust → JavaScript: Rust passes a `Request` and
collects the `Response`. The reverse direction uses `fetch` from framework
server code to reach Rust handlers in-process, with no HTTP connection or
listening socket ([in-process fetch](in-process-fetch.md)). With
`router_transport`, one axum router serves the public HTTP API and the
framework's server-side calls. A program that also serves browsers runs its
own HTTP server; fetchlet does not listen.

Named functions are a second entry point. `AppHandle::call` runs any export
of the bundle, which examples/honox-tauri uses for Tauri commands.

## Lifecycle

`AppHandle` owns the JavaScript thread. Start it during program
initialization, clone it into request handlers, and call `shutdown()` when
the program exits; shutdown stops accepting calls and waits for accepted
calls, background work and their resources. Dropping the last handle also
ends the thread.

## Tauri

fetchlet runs the server side and connects it to Rust; the window and
webview belong to the host. Two examples serve a webview without an HTTP
server, through a custom URI scheme protocol:

- **examples/honox-tauri** passes webview requests to `FetchletService`,
  serves `client/` with `ServeDir` and calls bundle functions from Tauri
  commands.
- **examples/sveltekit-axum-tauri** (`mdw`) is one binary that is both a
  CLI web server (`mdw serve`) and a desktop app (`mdw desktop`). Both pass
  requests to the same axum router, which serves the Rust API, workspace
  files, embedded assets and SvelteKit.

Pages load from `http://<scheme>.localhost/` on Windows (WebView2) and
Android and `<scheme>://localhost/` elsewhere; the app always receives
`http://<scheme>.localhost` URLs, so the public origin is stable. Tauri
treats registered schemes as local, so pages can use Tauri IPC.

Tauri-specific limits that apply to both examples:

- `UriSchemeResponder` takes a complete body, so streamed responses are
  collected within a response budget before they are returned.
- The webview collects request bodies before passing them on; arrival-order
  streaming uploads are not available.
- There is no client address.
- Tauri's CSP injection applies to its built-in asset protocol, not to
  custom schemes; set CSP in the application's response headers.

Automated checks run on Windows with WebView2. macOS (WKWebView) and Linux
(WebKitGTK) builds are not verified.

## Next measurements

Startup time, time to first content, distribution size and RSS will be
measured on the same application per engine and polyfill selection, and
compared with a static build of the same pages. Installers (`tauri build`)
and bundling configuration defaults into the binary are listed in [open
work](TODO.md).

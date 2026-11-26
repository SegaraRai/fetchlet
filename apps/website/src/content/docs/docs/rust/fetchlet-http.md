---
title: "Serving over HTTP (fetchlet-http)"
slug: docs/rust/fetchlet-http
description: "Serve fetchlet artifacts over HTTP with axum, hyper, actix, or Tower, or inside a Tauri webview."
---

`fetchlet-http` connects a fetchlet application to an HTTP server or a desktop
webview. Choose the integration level that fits your application:

| API                                                 | Feature                       | When to use                                                                                              |
| --------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Server`                                            | `axum`                        | Fastest way to serve a build artifact with static assets, Rust routes, dev reload, or a Tauri webview    |
| `Artifact` + `AxumService` + `artifact_router`      | `axum`                        | When you already own an axum `Router` and want full control over `AppBuilder`, middleware, and lifecycle |
| `FetchletService` / `HyperService` / `ActixService` | (default) / `hyper` / `actix` | Serving from Tower, hyper 1, or actix-web 4                                                              |

```sh
cargo add fetchlet
cargo add fetchlet-http --features axum
```

Select your JavaScript engine (`quickjs`, `boa`, or `v8`) on the `fetchlet`
crate; `fetchlet-http` has no engine features of its own.

| Feature           | Adds                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| (none)            | `FetchletService` (Tower, `http` 1), `service_transport`, `Artifact`, `AssetArchive`, `AssetService` |
| `hyper`           | `HyperService` and `HyperConnection` for hyper 1, `PeerAddr`                                         |
| `axum`            | `Server`, `AxumService`, `connect_info`, `router_transport`, `artifact_router`                       |
| `actix`           | `ActixService` for actix-web 4                                                                       |
| `axum-websocket`  | WebSocket upgrades in `AxumService` and `Server` (enables `axum`)                                    |
| `actix-websocket` | WebSocket upgrades in `ActixService` (enables `actix`)                                               |
| `dev-reload`      | `DevReload`, which reloads rebuilt artifacts during development                                      |
| `vite-dev`        | `ViteDev`, which runs server modules from a Vite dev server                                          |
| `process`         | `Server::isolation` for child-process isolation (`main` calls `fetchlet::serve_if_child()` first)    |

For outbound HTTP, TCP, and WebSocket clients from JavaScript, see
[Outbound networking](/docs/rust/fetchlet-net).

## Serving a build with `Server`

With the `axum` feature, `Server` handles the full lifecycle of a build
artifact: it routes your Rust endpoints first, then static client assets, then
your JavaScript framework, and shuts down cleanly on Ctrl-C (or a custom future
passed to `serve_with_shutdown`).

```rust
use axum::{Router, routing::get};
use fetchlet::HostServices;
use fetchlet_http::Server;

let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
Server::new("build")
    .host_services(|| HostServices::new().env("MESSAGE", "Hello"))
    .routes(|_app| Router::new().route("/api/rust", get(rust_endpoint)))
    .rendering(|service| service.stream_request_bodies())
    .serve(listener)
    .await?;
```

| Method                  | Default                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `host_services(f)`      | No bindings. `f` runs each time the server starts an application                                                      |
| `routes(f)`             | No Rust routes. `f` receives `AppHandle` so routes can call named JS exports or inspect `pool_state()`                |
| `rendering(f)`          | `AxumService` logging errors to stderr; customize to add request context or enable `stream_request_bodies()`          |
| `limits(limits)`        | `Server::default_limits()`: 10 s `busy_timeout` and 60 s `startup_timeout` (setting `limits` replaces these defaults) |
| `public_origin(origin)` | `http://<listener address>`                                                                                           |
| `backend(backend)`      | Matches the artifact's `backend` (`Backend::for_target`) with safe stack and 64 MiB QuickJS/V8 heap defaults          |
| `worker(options)`       | Queue capacity of 8 and a 64 MiB native worker stack                                                                  |
| `queue_capacity(n)`     | 8; overrides only the queue size                                                                                      |
| `instances(i)`          | 1 instance; set higher with `Instances` for concurrent SSR                                                            |
| `isolation(isolation)`  | In-process. With the `process` feature, `Isolation::Process` runs each instance in a child process                    |

### Default stack, heap, and concurrency settings

- **Stack sizes:** `Server` configures a 64 MiB native worker stack, a 4 MiB
  QuickJS stack limit, and 131,072 value-stack slots / 10,000 recursion calls on
  Boa so deep React/SSR trees render reliably in both debug and release builds.
- **Heap limits:** QuickJS and V8 default to a 64 MiB heap per instance.
  `V8Options::reliable_termination` is off by default; enable it in `backend()`
  if you run untrusted code that could enter an allocating infinite loop.
- **Concurrency:** each engine instance serves one request at a time. Increase
  concurrency with `.instances(...)`. When all instances are busy and the queue
  is full, incoming requests wait asynchronously.
- **Multi-thread Tokio runtime:** `Server` automatically passes its Tokio
  runtime to `AppBuilder::host_runtime` so background transport tasks (such as
  pooled HTTP connections) keep progressing while JavaScript runs.
- **Development features:** when enabled on a `dev` Cargo feature, `dev-reload`
  reloads rebuilt artifacts automatically and `vite-dev` switches `Server` to
  run from `FETCHLET_VITE_URL`. Keep both features out of release builds.

## Serving a webview's URI scheme

Desktop and mobile apps (such as Tauri) can render the framework directly inside
a webview over a custom URI scheme without opening a local TCP port:

```rust
use fetchlet_http::{Server, WebviewScheme};

const SCHEME: WebviewScheme = WebviewScheme::new("app");

let webview = Server::new("build")
    .host_services(|| HostServices::new().env("MESSAGE", "Hello"))
    .routes(|_app| Router::new().route("/api/rust", get(rust_endpoint)))
    .webview(SCHEME, 16 * 1024 * 1024)
    .await?;

let protocol = webview.clone();
tauri::Builder::default()
    .manage(webview.clone()) // Tauri commands can call JS exports via webview.app()
    .register_asynchronous_uri_scheme_protocol(SCHEME.name(), move |_, request, responder| {
        let protocol = protocol.clone();
        tauri::async_runtime::spawn(async move {
            responder.respond(protocol.respond(request).await);
        });
    });
```

- WebView2 (Windows) and Android load custom schemes from
  `http://<name>.localhost`, while other platforms use `<name>://localhost`.
  Use `WebviewScheme::start_url` for the initial window URL; your framework
  always sees a consistent `http://<name>.localhost` origin unless you set
  `public_origin`.
- Because Tauri's responder expects a complete body, `webview()` collects each
  response up to the byte limit passed as its second argument (exceeding it
  returns `502 Bad Gateway`).
- With `dev-reload`, listen to `webview.reloads()` to reload the window after
  each rebuild (`vite-dev` is not used for webviews). For custom routers, use
  `WebviewResponder` with any Tower service.

## Serving a build artifact with axum

When integrating into an existing axum (or Tower / hyper / actix) server, open
the artifact and start from `artifact.app_builder()?` and
`Artifact::default_worker_options()`. They automatically configure the target
backend, safe stack and heap defaults (64 MiB worker stack, 4 MiB QuickJS stack,
Boa value-stack and recursion limits), `artifact.requirements()`,
`artifact.handler()`, and `host_runtime`:

```rust
use fetchlet_http::{Artifact, AxumService, artifact_router};

let artifact = Artifact::open("build")?;
let app = artifact
    .app_builder()?
    .spawn(Artifact::default_worker_options())
    .await?;

let rendering = AxumService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));

let router = axum::Router::new()
    .route("/api/rust", get(rust_endpoint))
    .merge(artifact_router(&artifact, rendering));

axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await?;
```

Use `artifact.app_builder_with(backend)?` if you want to pass a custom `Backend`
while keeping the rest of those defaults.

- `artifact.requirements()` verifies at startup that your engine and features
  provide everything the build expects (such as native `Intl` on V8).
- Static files answer `GET` and `HEAD`; missing files and other methods fall
  through to your framework so it handles routes, form actions, and 404 pages.
- Manifest paths escaping the artifact directory are rejected.

## WebSocket upgrades

Enable `axum-websocket` (or `actix-websocket` for actix-web) to let a Fetch
handler accept WebSocket connections with `upgradeWebSocket(request)` from
`fetchlet/runtime`.

Each open WebSocket holds one engine instance until it closes, so configure a
pool with `max_held_connections` strictly less than `max`:

```rust
options.instances = Instances {
    max_held_connections: 3,
    ..Instances::fixed(NonZeroUsize::new(4).unwrap())
};
```

- With `max_held_connections: 0` (the default), upgrade requests are handled as
  plain HTTP requests and `upgradeWebSocket` throws.
- When all connection slots are full, new upgrade requests receive `503 Service
  Unavailable`.
- `Limits::channel_message_bytes` bounds frame/message sizes (exceeding it
  closes with `1009`), and `connection_idle_timeout` / `connection_lifetime`
  close idle or expired connections with `1001`.
- Under `ViteDev`, WebSocket upgrades always route to your app rather than the
  Vite dev server.

## Reloading during development

The `dev-reload` feature adds `DevReload` for custom hosts that want automatic
rebuilds and browser refresh without `Server`:

```rust
use fetchlet_http::{DevReload, Generation};

let reload = DevReload::watch("build")
    .start(move |artifact| async move {
        let (router, app) = application(&artifact).await?;
        anyhow::Ok(Generation::new(router).with_app(app))
    })
    .await?;

let router = axum::Router::new().fallback_service(reload.service());
axum::serve(listener, router).await?;
reload.shutdown().await?;
```

`DevReload` polls `fetchlet.json` every 200 ms (configurable via
`poll_interval`). On a new build, it starts a new `Generation`, swaps traffic to
it, shuts down the old generation once in-flight requests finish, and reloads
open HTML pages via `/__fetchlet/reload.js` (same-origin, compatible with
`script-src 'self'`). If a build fails, the previous generation continues
serving.

For custom webview hosts, call `reload.current().respond(request)` and watch
`reload.reloads()` to refresh the window:

```rust
let mut reloads = reload.reloads();
tauri::async_runtime::spawn(async move {
    while reloads.next().await.is_some() {
        let _ = window.reload();
    }
});
```

Keep `dev-reload` out of release builds: it serves internal `/__fetchlet/*`
endpoints and injects a reload script into HTML responses.

## Running from a Vite dev server

The `vite-dev` feature adds `ViteDev` to run server modules directly from
`vite dev` on your Rust engine while Vite serves browser modules and HMR:

```rust
use fetchlet_http::ViteDev;

let vite = ViteDev::new("http://127.0.0.1:5173")?;
let artifact = vite.artifact().await?;
let services = vite.host_services(host_services()?)?;
let (router, app) = application(&artifact, services).await?;
let router = axum::Router::new().fallback_service(vite.proxy(router));
axum::serve(listener, router).await?;
```

- `host_services` attaches an internal `FETCHLET_VITE` binding restricted to the
  Vite dev server origin (hidden from your application's `env`).
- `proxy` forwards `GET` and `HEAD` requests to Vite first for browser modules,
  HMR, and public files; Vite 404s and all other methods go to your app.
- Set `WorkerOptions::cancelled_calls` to `CancelledCalls::Finish` (which
  `Server` does automatically under `ViteDev`) so cancelled client navigations
  do not retire and re-evaluate the entire Vite module graph.

Keep `vite-dev` out of release builds.

## Asset archives

When your build includes `assets.flpk` (`assets: true` in the adapter),
`Artifact::open` and `artifact_router` automatically serve Brotli-compressed
assets directly from the archive. Outside axum, use `AssetService::new(archive,
fallback)` or embed the archive with `include_artifact!` / `include_bytes!`. See
[Asset archive](/docs/reference/asset-archive).

## Request handling

Every integration (`FetchletService`, `HyperService`, `AxumService`,
`ActixService`) follows the same rules:

- **Public origin:** the configured public origin replaces the request scheme
  and host, so untrusted `Host` headers never reach JavaScript.
- **Request bodies:** collected up to `request_body_bytes` before calling
  JavaScript (over budget returns `413`; unreadable body returns `400`). Call
  `stream_request_bodies()` to stream bodies as a `ReadableStream` instead.
- **Responses:** preserve binary bodies and repeated headers (such as
  `Set-Cookie`) and stream response bodies on demand.
- **Cancellation:** disconnecting a client drops the request future and cancels
  the invocation and its outbound fetches.

## Request context

- **Client address:** by default, the handler's second argument is
  `RequestContext { clientAddress }`, populated from `ConnectInfo<SocketAddr>`
  (axum), `PeerAddr` (hyper), `HttpRequest::peer_addr` (actix), or
  `client_address(...)` (Tower).
- **Custom visible context:** `context(|parts| ...)` passes any Serde value to
  JavaScript.
- **Trusted context:** `trusted_context(|parts| ...)` attaches a
  `fetchlet::Context` that stays invisible to JavaScript and is forwarded to
  in-process Rust routes registered with `OriginRouter::internal`.

## In-process transport

`service_transport(service)` wraps any Tower service as a
`fetchlet::FetchTransport`, and `router_transport(router)` wraps an axum
`Router`. Pair them with `OriginRouter::internal` so one axum router serves both
public HTTP traffic and in-process `fetch()` calls from JavaScript
([In-process fetch](/docs/rust/in-process-fetch)).

actix-web services are `!Send`, so use `fetchlet::transport_fn` or a Tower
service for in-process APIs alongside actix-web.

## Errors

When called as an HTTP service, detailed `fetchlet::Error` values are passed to
`on_error` while the client receives a generic HTTP status:

| Condition                                      | Status |
| ---------------------------------------------- | ------ |
| Invalid request target or body                 | 400    |
| Permission denied                              | 403    |
| Request body over budget                       | 413    |
| URL over budget                                | 414    |
| Worker closed, failed, or instance unavailable | 503    |
| WebSocket upgrade with all slots taken         | 503    |
| Deadline exceeded                              | 504    |
| Anything else                                  | 500    |

# fetchlet-http

Serves a shared fetchlet application (`fetchlet::AppHandle`) over HTTP. The Tower service is always available; Cargo features add thin layers for specific servers. The JavaScript engine is selected on the `fetchlet` crate, so this crate has no engine features.

| Feature           | Adds                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| (none)            | `FetchletService` (Tower, `http` 1), `service_transport`, `Artifact`                                    |
| `hyper`           | `HyperService` and `HyperConnection` for hyper 1 connections, `PeerAddr`                                |
| `axum`            | `Server`, `AxumService`, `connect_info`, `router_transport`, `artifact_router`                          |
| `actix`           | `ActixService` for actix-web 4                                                                          |
| `axum-websocket`  | WebSocket upgrades in `AxumService` and `Server` (enables `axum`)                                       |
| `actix-websocket` | WebSocket upgrades in `ActixService` (enables `actix`)                                                  |
| `dev-reload`      | `DevReload`, which serves each new build of an artifact during development                              |
| `vite-dev`        | `ViteDev`, which runs the server module from a Vite dev server                                          |
| `process`         | `Server::isolation`, with fetchlet's process isolation; `main` calls `fetchlet::serve_if_child()` first |

The transports of JavaScript's outbound sockets and WebSockets are in
[fetchlet-net](../fetchlet-net/README.md).

```sh
cargo add fetchlet --features quickjs
cargo add fetchlet-http --features axum
```

## Serving a build with `Server`

With the `axum` feature, `Server` serves one `fetchlet/build` artifact on a
listener: the caller's Rust routes first, then the client assets, then the
application. It starts the engine the artifact was built for and shuts the
application down after Ctrl-C (or the future given to
`serve_with_shutdown`). It is available when the `fetchlet` crate is
built with an engine feature; its build script reports the enabled engines
to this crate (`links = "fetchlet"`), so the engine stays a choice on
`fetchlet`.

```rust,ignore
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

| Method                  | Default                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host_services(f)`      | No bindings. `f` runs for each application the server starts                                                                                                                                        |
| `routes(f)`             | No Rust routes. `f` receives the `AppHandle`, so a route can call named exports                                                                                                                     |
| `rendering(f)`          | `AxumService` with errors written to standard error; `f` adds a context or streams request bodies                                                                                                   |
| `limits(limits)`        | `Server::default_limits()`: a 10 s `busy_timeout` and a 60 s `startup_timeout`; limits given here replace them                                                                                      |
| `public_origin(origin)` | `http://` and the listener's address                                                                                                                                                                |
| `backend(backend)`      | `Backend::for_target` of the artifact's `backend` with a 64 MiB QuickJS or V8 heap limit; with the default worker, a 4 MiB QuickJS stack limit; for Boa, 131,072 value stack slots and 10,000 calls |
| `worker(options)`       | A queue of 8 commands and a 64 MiB native stack                                                                                                                                                     |
| `queue_capacity(n)`     | 8; changes only the queue of the worker options                                                                                                                                                     |
| `instances(i)`          | One instance; changes only the instances of the worker options                                                                                                                                      |
| `isolation(isolation)`  | In process. With the `process` feature, `Isolation::Process` runs each instance in a child process; the child's engine thread gets the worker's stack unless `ProcessOptions::stack_bytes` is set   |

The stack defaults are the depth the repository's framework examples need:
React's server renderer retries an element after a QuickJS stack overflow
and can leave a partial tag behind, and React Server Components rendering
on Boa needs the larger value stack. Boa's own recursion limit of 512 calls
stops ordinary recursive code with an error scripts cannot catch, so the
server allows 10,000, close to Node. Boa serializes JSON on the native stack
without a depth check, and an overflow there aborts the process; the 64 MiB
worker stack, which the operating system commits only as it is used, moves
that point beyond `JSON.stringify` of 10,000 nested arrays in debug builds
and 50,000 in release builds. QuickJS and V8 throw a catchable `RangeError`
instead.

The QuickJS heap limit is twice what the largest example, Astro, needs to
serve its pages, and the V8 heap limit more than twice what vinext and Waku
need; with `Instances::max` they bound a pool's JavaScript heap. The busy
timeout is a backstop for JavaScript stuck in a loop: the examples' pages
return to the event loop within 100 ms in a release build, and it leaves
room for debug builds, which run about ten times slower. The startup
timeout covers the slowest module evaluation measured, Astro's development
modules on a debug build of Boa
([measured needs](../../docs/research/interrupts-and-heap-limits.md#measured-needs-of-the-examples)).
Neither the timeouts nor the V8 heap limit changed the examples' request
latency measurably. `V8Options::reliable_termination` stays off: set it in
`backend` for code that may run a loop that never returns.

[Startup and memory](../../docs/research/startup-and-memory.md#recommended-settings)
measures each example's needs and recommends the timeout, instance counts
and queue for a server.

The queue bounds the commands waiting for the instances. Each instance runs
one request at a time, and the default worker options have one; set
more with `instances`. Each instance keeps its own module state and heap;
[sizing](../../docs/research/instance-pools.md#sizing) gives measured
throughput by pool size and how to choose `max`. When the
queue is full, further requests wait for room rather than fail, so a slow
handler shows up as latency. When the server runs on a multi-thread Tokio
runtime, it passes that runtime to `AppBuilder::host_runtime`, so tasks that
host transports spawn, such as pooled connections, keep running while an
instance runs JavaScript. To watch a pool, read `AppHandle::pool_state`
from the handle that `routes` receives, for example in a route of your own
behind your access control; the server serves no metrics by itself.

The crate's development features change how `serve` serves the build, with
the same routes and services:

- `dev-reload`: through `DevReload`, which serves each build written to the
  directory and reloads open pages ([reloading during development](#reloading-during-development)).
- `vite-dev`: when the `FETCHLET_VITE_URL` environment variable names a Vite
  dev server, through `ViteDev`, which runs the server module from it, with
  console output on standard error ([running from a Vite dev server](#running-from-a-vite-dev-server)).

Enable them in a `dev` feature of the application, not in release builds.
The sections below are the parts `Server` combines, for hosts that need
another arrangement.

## Serving a webview's URI scheme

A desktop or mobile host, such as a Tauri app, can show the application in a
webview without an HTTP server: the webview loads pages from a custom URI
scheme, and the host answers its requests in-process. `Server::webview`
starts the application for such a scheme instead of a listener, with the
same routes, services and defaults as `serve`:

```rust,ignore
use fetchlet_http::{Server, WebviewScheme};

const SCHEME: WebviewScheme = WebviewScheme::new("app");

let webview = Server::new("build")
    .host_services(|| HostServices::new().env("MESSAGE", "Hello"))
    .routes(|_app| Router::new().route("/api/rust", get(rust_endpoint)))
    .webview(SCHEME, 16 * 1024 * 1024)
    .await?;
let protocol = webview.clone();
tauri::Builder::default()
    .manage(webview.clone()) // commands call named exports through webview.app()
    .register_asynchronous_uri_scheme_protocol(SCHEME.name(), move |_, request, responder| {
        let protocol = protocol.clone();
        tauri::async_runtime::spawn(async move {
            responder.respond(protocol.respond(request).await);
        });
    })
    // ...
```

WebView2 and Android load a custom scheme from `http://<name>.localhost`,
the other platforms from `<name>://localhost`; `WebviewScheme::start_url`
returns the one for the platform, and the application sees
`http://<name>.localhost` (`WebviewScheme::origin`) on every platform unless
`public_origin` names another. Tauri's responder takes a whole body, so each
response is collected first; the second argument of `webview` bounds what is
collected, a memory budget the caller sets, and a larger response becomes a
`502 Bad Gateway`. Request bodies arrive whole too, within the application's
`request_body_bytes`.

With `dev`, each build written to the directory answers the next request,
and `Webview::reloads()` yields once per new build so the host can reload
its window; pages get no reload script, since the scheme's responses are
not watched by one. `vite-dev` does not apply to a webview. A host that
keeps its own router, such as one shared with an HTTP server, answers the
scheme with `WebviewResponder`, which takes any Tower service for each
request, such as `DevReload::current()`'s, and collects its responses
within the same kind of budget.

## Serving a build artifact with axum

`Artifact` reads the output of `fetchlet/build` (`fetchlet.json`, `server.js` and `client/`). `artifact_router` serves the client files and passes every other request to the application.

```rust,ignore
use fetchlet::{App, Backend, Module, WorkerOptions};
use fetchlet_http::{Artifact, AxumService, artifact_router};

let artifact = Artifact::open("build")?;
let app = App::builder(Backend::quickjs())
    .module(Module::new(artifact.server_source()?).requires(artifact.requirements()))
    .fetch_handler(artifact.handler())
    .spawn(WorkerOptions::new(queue_capacity))
    .await?;
let rendering = AxumService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));
let router = axum::Router::new()
    .route("/api/rust", get(rust_endpoint))
    .merge(artifact_router(&artifact, rendering));
axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await?;
```

`artifact.requirements()` carries what the build left to the host, such as native Intl APIs on a V8 build; building the App checks them against its engine before `server.js` runs, and refuses a host that lacks one with an error naming each. `Server` does this itself.

Manifest paths that leave the artifact directory are refused. Client files answer GET and HEAD; other methods and missing files reach the application, so the framework handles its own routes, actions and 404 pages.

## WebSocket upgrades

With the `axum-websocket` feature, a Fetch handler accepts a WebSocket with
`upgradeWebSocket(request)` from `fetchlet/runtime`, and `AxumService`
completes the handshake and relays frames between the connection and the
handler's socket; the `actix-websocket` feature does the same for
`ActixService` with actix-ws. Under `ViteDev`, upgrade requests go to the
app, never to the Vite dev server. The invocation, and its instance, stay held until the
connection closes, so the pool must leave instances for requests:

```rust
options.instances = Instances {
    max_held_connections: 3,
    ..Instances::fixed(NonZeroUsize::new(4).unwrap())
};
```

`max_held_connections` must be below `max`, and defaults to 0. With 0, upgrade
requests reach the handler as ordinary requests and `upgradeWebSocket`
throws. Otherwise each upgrade request takes a place before JavaScript runs;
with every place taken, the answer is 503. The 101 carries the handler's
headers and its `Sec-WebSocket-Protocol`. A close from either side goes to
the other, and a connection that fails without a closing handshake reaches
JavaScript as code 1006 and the peer as 1011. `Limits::channel_message_bytes`
also bounds each frame and message from the client, and a larger one closes
the connection with 1009 under actix; and `connection_idle_timeout` and
`connection_lifetime` close the connection with 1001. `tests/websocket.rs`
and `tests/actix_websocket.rs` cover the handshake, both closing
handshakes, a client that goes away, the 503 and shutdown over a real
socket on every engine, and the actix tests also pings, fragmented messages
and the message budget.

## Reloading during development

The `dev-reload` feature adds `DevReload`, which serves an artifact while a build tool such as `vite build --watch` rewrites it. `fetchlet/build` writes `fetchlet.json` last, through a rename. When its modification time changes, `DevReload` opens the artifact again and builds a new `Generation` with the caller's function, serves it from then on and shuts the previous applications down after their accepted calls finish. A build that fails to open or start is reported, and the previous generation keeps serving.

```rust,ignore
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

`DevService` answers two paths itself: `/__fetchlet/reload.js`, a module script that long-polls `/__fetchlet/reload` and reloads the page when a new generation starts or the server restarts, and that poll. Every other request reaches the current generation, and HTML responses get a `<script type="module" src="/__fetchlet/reload.js?token=…">` element appended. The script comes from the page's own origin, so a Content Security Policy that allows `'self'` scripts allows it. The service drops `Accept-Encoding` from requests, so asset archives answer uncompressed, and leaves responses that still carry a `Content-Encoding` unchanged. The manifest is checked every 200 ms by default (`poll_interval`); a file system whose modification times are coarser than the interval between two builds can miss the second build until the next one. Keep the feature out of release builds: it serves extra paths and changes HTML responses.

A host that answers a webview's URI scheme itself ([serving a webview's URI scheme](#serving-a-webviews-uri-scheme)) takes `DevReload::current()` for each request and waits on `DevReload::reloads()` to reload its views when a new generation serves:

```rust,ignore
let mut reloads = reload.reloads();
tauri::async_runtime::spawn(async move {
    while reloads.next().await.is_some() {
        if let Err(error) = window.reload() {
            eprintln!("could not reload the window: {error}");
        }
    }
});
// For each webview request:
let response = reload.current().respond(request).await;
```

## Running from a Vite dev server

The `vite-dev` feature adds `ViteDev`, which runs a server module from `vite dev` with `fetchlet/vite` instead of from a build. The dev server builds a development artifact whose server module runs Vite's module runner in the engine; the runner loads the app's server module and its imports from Vite, and reloads the modules a file change touched before the next call, so a server edit takes effect on the next request without a new instance. Browser modules keep Vite's hot module replacement.

```rust,ignore
use fetchlet_http::ViteDev;

let vite = ViteDev::new("http://127.0.0.1:5173")?;
let artifact = vite.artifact().await?;
let services = vite.host_services(host_services()?)?;
let (router, app) = application(&artifact, services).await?;
let router = axum::Router::new().fallback_service(vite.proxy(router));
axum::serve(listener, router).await?;
```

- `host_services` adds the `FETCHLET_VITE` binding, through which the runner reaches the dev server. Its policy allows only the binding's own origin, the application's services and their `FetchPolicy`s stay as they are, and the runner removes the binding from the `env` the server module sees.
- `proxy` sends `GET` and `HEAD` requests to Vite first, which answers browser modules, its HMR client and public files; Vite's 404s and every other method go to the app. The runner's own endpoints under `/@fetchlet/` stay with the app. The browser opens Vite's HMR WebSocket on Vite's port.
- The engine, the Web API profile, host services, in-process fetch and the `Context` are those of the application. What differs from a release build: modules are evaluated one by one with `AsyncFunction` instead of as one bundle, module state is lost when its module changes, and the named exports `App::call` reaches are those the server module had when the dev server built the development artifact.

- A new instance fetches and evaluates every module from Vite again, which takes seconds for a framework. Spawn the application with `WorkerOptions::cancelled_calls` set to `CancelledCalls::Finish`, so that a request the client cancels, as client routers do when they navigate, runs to the end of its evaluation in the instance instead of retiring it. `Server` does this when it serves from Vite.

Keep the feature out of release builds: it runs whatever the dev server sends.

## Asset archives

`archiveArtifactAssets` in `fetchlet/build` packs the client directory into
`assets.flpk` and names it in `fetchlet.json`. `Artifact::open` then reads and
checks it, and `artifact_router` serves assets from it instead of the
directory. Text assets are stored Brotli-compressed and sent as they are to
clients that accept `br`; other clients receive them decompressed. Outside
axum, `AssetService::new(archive, fallback)` is the same Tower service; an
archive can also be embedded with
`AssetArchive::new(Bytes::from_static(include_bytes!("assets.flpk")))`.
[docs/asset-archive.md](../../docs/asset-archive.md) describes the format and
the responses.

## Request handling

These rules hold for every integration and are checked by the shared contract in `tests/contract/`:

- The configured public origin supplies the scheme and authority. The incoming path, query, method and headers are kept, so the Host header that clients choose does not reach the application.
- By default the request body is collected within the application's `request_body_bytes` budget before the handler runs. Exceeding it answers 413; a failing client body answers 400.
- `stream_request_bodies()` passes the body to the handler as a `ReadableStream`. A declared `Content-Length` over the budget is still refused with 413 before execution. Undeclared excess and client body failures become errors of the handler's body stream, so the handler decides the status.
- Responses keep binary bodies and repeated headers such as `Set-Cookie`, and stream their bodies.
- Dropping the request future, for example when the client disconnects, cancels the invocation and its host fetches.

## Context

- The Fetch entry's second argument defaults to `RequestContext { clientAddress }`. The axum layer reads `ConnectInfo<SocketAddr>`, the hyper layer reads `PeerAddr`, actix reads `HttpRequest::peer_addr`. On the Tower service, `client_address(|parts| ...)` says where the address is.
- `context(|parts| ...)` replaces the default with any Serde value.
- `trusted_context(|parts| ...)` derives a `fetchlet::Context` in Rust. It stays out of JavaScript; host fetches carry it to in-process routes registered with `OriginRouter::internal`.

## In-process transport

`service_transport(service)` turns any Tower service into a `fetchlet::FetchTransport`; `router_transport(router)` does the same for an axum `Router`. Registered with `OriginRouter::internal`, one router serves public HTTP and in-process fetches from JavaScript. Handlers read the trusted Context with `Option<Extension<fetchlet::Context>>`. A service error rejects the fetch with a general transport error; the detail stays in Rust.

actix-web services are not `Send`, so there is no actix transport. Use `fetchlet::transport_fn` or a Tower service for in-process APIs next to an actix server.

## Errors

`fetch` returns the detailed `Error`. Called as a service, the integration reports the detail to `on_error` and answers with a general response:

| Condition                                     | Status |
| --------------------------------------------- | ------ |
| Invalid request target or body                | 400    |
| Permission denied                             | 403    |
| Request body over budget                      | 413    |
| URL over budget                               | 414    |
| Worker closed, failed or instance unavailable | 503    |
| WebSocket upgrade with every held place taken | 503    |
| Deadline exceeded                             | 504    |
| Anything else                                 | 500    |

## Tests

`tests/contract/` drives each integration with requests of its own server: Tower in memory, hyper over loopback TCP, axum through its router and actix through its test service. Each check runs on QuickJS, Boa and V8. `tests/axum_router.rs` covers one router serving public and in-process requests, `tests/artifact.rs` covers artifact reading and asset serving, `tests/dev.rs` covers reloading, the reload poll and failed builds, and `tests/vite_dev.rs` covers the development artifact and the proxy against a stand-in dev server.

```bash
vp run test:rust
```

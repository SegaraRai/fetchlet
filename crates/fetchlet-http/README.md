# fetchlet-http

Serves a shared fetchlet application (`fetchlet::AppHandle`) over HTTP. The Tower service is always available; Cargo features add thin layers for specific servers. The JavaScript engine is selected on the `fetchlet` crate, so this crate has no engine features.

| Feature | Adds                                                                     |
| ------- | ------------------------------------------------------------------------ |
| (none)  | `FetchletService` (Tower, `http` 1), `service_transport`, `Artifact`     |
| `hyper` | `HyperService` and `HyperConnection` for hyper 1 connections, `PeerAddr` |
| `axum`  | `AxumService`, `connect_info`, `router_transport`, `artifact_router`     |
| `actix` | `ActixService` for actix-web 4                                           |

```toml
[dependencies]
fetchlet = { version = "...", features = ["quickjs"] }
fetchlet-http = { version = "...", features = ["axum"] }
```

## Serving a build artifact with axum

`Artifact` reads the output of `fetchlet/build` (`fetchlet.json`, `server.js` and `client/`). `artifact_router` serves the client files and passes every other request to the application.

```rust,ignore
use fetchlet::{App, Backend, Module, WorkerOptions};
use fetchlet_http::{Artifact, AxumService, artifact_router};

let artifact = Artifact::open("build")?;
let app = App::builder(Backend::quickjs())
    .module(Module::new(artifact.server_source()?))
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

Manifest paths that leave the artifact directory are refused. Client files answer GET and HEAD; other methods and missing files reach the application, so the framework handles its own routes, actions and 404 pages.

## Reloading during development

The `dev` feature adds `DevReload`, which serves an artifact while a build tool such as `vite build --watch` rewrites it. `fetchlet/build` writes `fetchlet.json` last, through a rename. When its modification time changes, `DevReload` opens the artifact again and builds a new `Generation` with the caller's function, serves it from then on and shuts the previous applications down after their accepted calls finish. A build that fails to open or start is reported, and the previous generation keeps serving.

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
| Deadline exceeded                             | 504    |
| Anything else                                 | 500    |

## Tests

`tests/contract/` drives each integration with requests of its own server: Tower in memory, hyper over loopback TCP, axum through its router and actix through its test service. Each check runs on QuickJS, Boa and V8. `tests/axum_router.rs` covers one router serving public and in-process requests, `tests/artifact.rs` covers artifact reading and asset serving, and `tests/dev.rs` covers reloading, the reload poll and failed builds.

```bash
vp run test:rust
```

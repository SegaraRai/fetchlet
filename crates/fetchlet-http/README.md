# fetchlet-http

Serve a [`fetchlet`](https://crates.io/crates/fetchlet) build artifact over HTTP
(axum, hyper, actix-web, or Tower) or inside a Tauri webview over a custom URI
scheme.

```sh
cargo add fetchlet
cargo add fetchlet-http --features axum
```

## Quick example

```rust
use fetchlet::HostServices;
use fetchlet_http::Server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    Server::new("build")
        .host_services(|| HostServices::new().env("MESSAGE", "Hello"))
        .serve(listener)
        .await?;
    Ok(())
}
```

Select your JavaScript engine (`quickjs`, `boa`, or `v8`) on the `fetchlet`
crate; `fetchlet-http` has no engine features of its own.

## Cargo features

| Feature           | Adds                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| (none)            | `FetchletService` (Tower, `http` 1), `service_transport`, `Artifact`, `AssetArchive`, `AssetService`   |
| `hyper`           | `HyperService`, `HyperConnection`, `PeerAddr` for hyper 1                                              |
| `axum`            | `Server`, `AxumService`, `connect_info`, `router_transport`, `artifact_router`                         |
| `actix`           | `ActixService` for actix-web 4                                                                         |
| `axum-websocket`  | Server WebSocket upgrades in `AxumService` and `Server` (enables `axum`)                               |
| `actix-websocket` | Server WebSocket upgrades in `ActixService` (enables `actix`)                                          |
| `dev-reload`      | `DevReload` for reloading rebuilt artifacts during development                                         |
| `vite-dev`        | `ViteDev` for running server modules directly from a Vite dev server                                   |
| `process`         | `Server::isolation` for child-process isolation                                                        |

For outbound HTTP, TCP, and WebSocket clients from JavaScript, see
[`fetchlet-net`](https://crates.io/crates/fetchlet-net).

## Documentation

- **Guide:** <https://fetchlet.roundtrip.dev/docs/rust/fetchlet-http>
- **API reference:** <https://docs.rs/fetchlet-http>
- **Full documentation:** <https://fetchlet.roundtrip.dev/docs>
- **Coding agents:** installing the `fetchlet` npm package bundles Markdown docs
  and skills in `node_modules/fetchlet/`
  ([guide](https://fetchlet.roundtrip.dev/docs/agents)).

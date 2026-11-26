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
[fetchlet-net](https://fetchlet.roundtrip.dev/docs/rust/fetchlet-net).

```sh
cargo add fetchlet --features quickjs
cargo add fetchlet-http --features axum
```

## Documentation

The guide to this crate is at <https://fetchlet.roundtrip.dev/docs/rust/fetchlet-http>, and its API reference
is on [docs.rs](https://docs.rs/fetchlet-http). The fetchlet documentation starts at
<https://fetchlet.roundtrip.dev/docs>.

A JavaScript application that installs the `fetchlet` npm package also has
this documentation as Markdown in `node_modules/fetchlet/docs/`, where coding
agents can read the version that the application uses
([Coding agents](https://fetchlet.roundtrip.dev/docs/agents)).

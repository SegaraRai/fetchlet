---
"@fetchlet-crates/fetchlet-http": minor
---

`ActixService` accepts WebSocket upgrades with the new `actix-websocket` feature: a handler's `upgradeWebSocket(request)` holds its invocation as with `AxumService`, actix-ws completes the handshake, and messages, pings, fragmented messages and both closing handshakes cross between the connection and the handler's socket. With every place among `Instances::max_held_connections` taken, an upgrade is answered with 503 before JavaScript runs, and a message over `Limits::channel_message_bytes` closes the connection with 1009. `ViteDev`'s proxy now passes upgrade requests to the app instead of the Vite dev server, so WebSocket routes work under `vite dev`.

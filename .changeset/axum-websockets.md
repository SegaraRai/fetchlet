---
"@fetchlet-crates/fetchlet-http": minor
---

The `websocket` feature completes WebSocket upgrades in `AxumService` and `Server`: it takes a held place before JavaScript runs, answers 503 when every place is taken, sends the 101 with the handler's headers and selected subprotocol, and relays frames and closing handshakes between the connection and the handler's socket. With `max_held_connections` at 0, upgrade requests reach the handler as before.

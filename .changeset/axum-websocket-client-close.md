---
"@fetchlet-crates/fetchlet-http": patch
---

`AxumService` completes the closing handshake a WebSocket client starts. When JavaScript's answering close arrived before the server's reply was written, the connection ended without that reply, and the client saw a reset instead of its close frame.

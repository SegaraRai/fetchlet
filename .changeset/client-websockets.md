---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": minor
"@fetchlet/web": minor
"fetchlet": minor
---

Open client WebSockets from JavaScript with the global `WebSocket`. `HostServices::websockets` takes a `WebSocketService`, which pairs a `WebSocketTransport` (or an async function through `websocket_fn`) with the `FetchPolicy` that authorizes each URL's origin, `ws:` and `wss:` counting as `http:` and `https:`, and can rewrite URLs and add credential headers to the opening handshake. The transport settles the handshake with a `WebSocketAccept`, whose subprotocol and extensions become the socket's `protocol` and `extensions`. fetchlet-http's new `websocket-client` feature provides `WebSocketClient`, which shares `TcpTransport`'s address checks and TLS and bounds each message by `Limits::channel_message_bytes`. A refused origin, a failed handshake and a host without a WebSocket service fire `error` and `close` with 1006. A client WebSocket is a channel of its invocation and counts against `Limits::open_channels`. `@fetchlet/web/channels` exports the channel registry's types, and `@fetchlet/web/websocket` now exports only the upgrade API.

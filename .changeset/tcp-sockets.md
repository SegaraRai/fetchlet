---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": minor
"@fetchlet/web": minor
"fetchlet": minor
---

Open TCP connections from JavaScript with the Sockets API's `connect(address, options)`, exported by `fetchlet/runtime` and `@fetchlet/web/sockets`. `HostServices::sockets` takes a `SocketService`, which pairs a `SocketTransport` (or an async function through `socket_fn`) with a `SocketPolicy` of exact hosts and port ranges, and can rewrite addresses before the check. fetchlet-http's new `sockets` feature provides `TcpTransport`, which refuses non-public resolved addresses unless allowed and speaks TLS for `secureTransport: "on"`. A socket is a channel of its invocation and counts against `Limits::open_channels`; `startTls()` and half-open sockets are not supported yet. `ChannelEnd::guest_gone` waits until JavaScript's end goes away.

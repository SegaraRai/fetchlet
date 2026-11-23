---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": minor
"@fetchlet/web": minor
"fetchlet": minor
---

Open TCP connections from JavaScript with the Sockets API's `connect(address, options)`, exported by `fetchlet/runtime` and `@fetchlet/web/sockets`. `HostServices::sockets` takes a `SocketService`, which pairs a `SocketTransport` (or an async function through `socket_fn`) with a `SocketPolicy` of exact hosts and port ranges, and can rewrite addresses before the check. fetchlet-http's new `sockets` feature provides `TcpTransport`, which refuses non-public resolved addresses unless allowed and speaks TLS for `secureTransport: "on"`. `secureTransport: "starttls"` with `startTls()` upgrades a plain socket to TLS, and `allowHalfOpen` keeps the writable open after the peer's bytes end; closing the writable half-closes the connection. A socket is a channel of its invocation and counts against `Limits::open_channels`. `ChannelEvent` gains `End` and `StartTls`, the signals of a socket's half close and TLS upgrade, and is now `#[non_exhaustive]`; `ChannelEnd::finish`, `confirm_tls` and `guest_gone` serve socket transports.

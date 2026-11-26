---
title: "Outbound networking (fetchlet-net)"
slug: docs/rust/fetchlet-net
description: "Configure outbound HTTP, TCP/TLS socket, and WebSocket clients for JavaScript."
---

JavaScript inside fetchlet has no network access by default. `fetchlet-net`
provides ready-made Rust transports for outbound `fetch()`, TCP `connect()`, and
client `WebSocket` connections, paired with `fetchlet`'s allowlist policies.

All three transports resolve DNS in Rust, **block private, loopback, and
link-local IP addresses by default** (to prevent SSRF), and use `rustls` with
`webpki-roots` for TLS.

```sh
cargo add fetchlet-net
```

| Feature               | Adds                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `http` (default)      | `HttpClient` for JavaScript's `fetch()`                              |
| `sockets` (default)   | `TcpTransport` for JavaScript's `connect()`                          |
| `websocket` (default) | `WebSocketClient` for JavaScript's global `WebSocket`                |

`rustls` is re-exported from `fetchlet_net` for passing a custom
`rustls::ClientConfig` to `with_tls_config()`.

## Outbound HTTP (`HttpClient`)

Attach `HttpClient` to `HostServices::outbound` (for global `fetch`) or
`HostServices::service` (for a named binding) with a `FetchPolicy`:

```rust
use fetchlet::{FetchPolicy, FetchService, HostServices};
use fetchlet_net::HttpClient;

let policy = FetchPolicy::deny_all().allow_origin("https://api.example.com")?;
let hosts = HostServices::new().outbound(FetchService::new(HttpClient::new(), policy));
```

- **Protocol & pooling:** speaks HTTP/1.1 and HTTP/2 (via ALPN over TLS) through
  hyper, pooling connections per origin with a 90-second idle timeout
  (`pool_idle_timeout`).
- **Streaming & redirects:** response bodies stream on demand; redirects are
  returned to `FetchService` so every hop is re-checked against your
  `FetchPolicy` and `Limits::redirects`.
- **Automatic decompression:** sends `Accept-Encoding: gzip, deflate, br` and
  transparently decodes responses in chunks (capped at 64 KiB per chunk, counted
  against `Limits::response_body_bytes`). Decoded responses have
  `Content-Encoding` and `Content-Length` removed so downstream readers see
  matching headers. Requests that set their own `Accept-Encoding`, `HEAD`
  requests, and unknown encodings (such as `zstd`) are passed through untouched.
- **Private addresses:** call `HttpClient::new().allow_private_addresses()` if
  your app legitimately calls localhost or private network services.
- **Tokio runtime:** requests execute on the Tokio runtime polling the host
  (automatically wired up by `fetchlet_http::Server`).

## Outbound TCP & TLS (`TcpTransport`)

Pair `TcpTransport` with `SocketPolicy` to allow JavaScript's `connect()` from
`fetchlet/runtime` to reach specific hosts and ports:

```rust
use fetchlet::{HostServices, SocketPolicy, SocketService};
use fetchlet_net::TcpTransport;

let policy = SocketPolicy::deny_all().allow("db.example.com", 5432)?;
let hosts = HostServices::new().sockets(SocketService::new(TcpTransport::new(), policy));
```

- Supports plain TCP (`secureTransport: "off"`), TLS (`secureTransport: "on"`),
  and STARTTLS upgrades (`secureTransport: "starttls"`).
- Refuses non-public resolved IP addresses unless `allow_private_addresses()` is
  called.
- Supports half-closing the write side; all open sockets are dropped when the
  invocation ends.

## Outbound WebSockets (`WebSocketClient`)

Pair `WebSocketClient` with `FetchPolicy` to allow JavaScript's global
`WebSocket` (`ws:` / `wss:` map to `http:` / `https:` in the policy):

```rust
use fetchlet::{FetchPolicy, HostServices, WebSocketService};
use fetchlet_net::WebSocketClient;

let policy = FetchPolicy::deny_all().allow_origin("https://chat.example.com")?;
let hosts = HostServices::new()
    .websockets(WebSocketService::new(WebSocketClient::new(), policy));
```

- Enforces the same DNS/private-address checks and TLS configuration as
  `TcpTransport`.
- Forwards requested subprotocols and any Rust-injected handshake credentials.
- Bounds incoming frame and message sizes with `Limits::channel_message_bytes`
  (closing with code `1009` if exceeded).

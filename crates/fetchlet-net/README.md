# fetchlet-net

Outbound HTTP, TCP/TLS socket, and WebSocket transports for
[`fetchlet`](https://crates.io/crates/fetchlet) applications. Each transport
pairs with `fetchlet`'s allowlist policies, resolves DNS in Rust, blocks
non-public IP addresses by default to prevent SSRF, and speaks TLS with `rustls`
and `webpki-roots`.

```sh
cargo add fetchlet
cargo add fetchlet-net
```

## Quick example

```rust
use fetchlet::{FetchPolicy, FetchService, HostServices};
use fetchlet_net::HttpClient;

let policy = FetchPolicy::deny_all().allow_origin("https://api.example.com")?;
let hosts = HostServices::new()
    .outbound(FetchService::new(HttpClient::new(), policy));
```

## Cargo features

| Feature               | Adds                                                        |
| --------------------- | ----------------------------------------------------------- |
| `http` (default)      | `HttpClient` — HTTP/1.1 & HTTP/2 transport for `fetch()`    |
| `sockets` (default)   | `TcpTransport` — TCP, TLS, and STARTTLS for `connect()`     |
| `websocket` (default) | `WebSocketClient` — client transport for global `WebSocket` |

`rustls` is re-exported for custom TLS configs passed to `with_tls_config()`.

## Documentation

- **Guide:** <https://fetchlet.roundtrip.dev/docs/rust/fetchlet-net>
- **API reference:** <https://docs.rs/fetchlet-net>
- **Full documentation:** <https://fetchlet.roundtrip.dev/docs>
- **Coding agents:** installing the `fetchlet` npm package bundles Markdown docs
  and skills in `node_modules/fetchlet/`
  ([guide](https://fetchlet.roundtrip.dev/docs/agents)).

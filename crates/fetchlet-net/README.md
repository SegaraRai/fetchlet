# fetchlet-net

Outbound network transports for fetchlet applications: the requests of
JavaScript's `fetch` and the connections of its `connect()` and global
`WebSocket`, which reach the network only through Rust. Each transport serves a `fetchlet` host service, whose
policy decides what JavaScript may reach; the transport resolves names,
refuses non-public addresses unless allowed and speaks TLS with rustls and
the `ring` provider. The JavaScript engine is selected on the `fetchlet`
crate.

| Feature               | Adds                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `http` (default)      | `HttpClient`, the HTTP/1.1 and HTTP/2 transport of JavaScript's fetch |
| `sockets` (default)   | `TcpTransport`, the TCP and TLS transport of JavaScript's `connect()` |
| `websocket` (default) | `WebSocketClient`, the transport of JavaScript's global `WebSocket`   |

```toml
[dependencies]
fetchlet = { version = "...", features = ["quickjs"] }
fetchlet-net = "..."
```

`rustls` is re-exported for TLS configurations given to `with_tls_config`.

## HTTP

With the `http` feature, `HttpClient` sends JavaScript's outbound `fetch`
requests as a `FetchTransport`. Register it as the outbound transport, or
behind an env binding, with a `FetchPolicy` that names the origins
JavaScript may reach
([host services](../../docs/host-services.md#bindings)):

```rust,ignore
use fetchlet::{FetchPolicy, FetchService, HostServices};
use fetchlet_net::HttpClient;

let policy = FetchPolicy::deny_all().allow_origin("https://api.example.com")?;
let hosts = HostServices::new().outbound(FetchService::new(HttpClient::new(), policy));
```

Each call sends one request through hyper and returns the response as soon
as its head arrives, with the body streaming as JavaScript reads it; a
redirect returns to the caller, which follows it under the service's
policy and the `redirects` budget. hyper speaks HTTP/1.1, and HTTP/2 when a
TLS server selects it by ALPN; a `rustls::ClientConfig` that names its own
ALPN protocols keeps them. Connections to one origin are pooled and reused,
and an idle one closes after `pool_idle_timeout`, 90 seconds by default.
Each new connection resolves its host and refuses addresses that are not
public unless `allow_private_addresses`, and TLS verifies servers as
`TcpTransport` does. The client adds no `Accept-Encoding` and decodes no
`Content-Encoding`, so the body reaches JavaScript as the server sent it.
Dropping the request's future or its response body ends that exchange.
Requests run on the Tokio runtime that polls the host pump; an App without
one fails each request with `Configuration`. `tests/http.rs` checks it
against local HTTP/1.1 and HTTP/2-over-TLS servers, and the global `fetch`
on every engine.

## TCP sockets

With the `sockets` feature, `TcpTransport` opens the connections of
JavaScript's `connect()` for a `SocketService`, whose `SocketPolicy` names
the hosts and ports JavaScript may reach
([host services](../../docs/host-services.md#sockets)):

```rust,ignore
use fetchlet::{HostServices, SocketPolicy, SocketService};
use fetchlet_net::TcpTransport;

let policy = SocketPolicy::deny_all().allow("db.example.com", 5432)?;
let hosts = HostServices::new().sockets(SocketService::new(TcpTransport::new(), policy));
```

`TcpTransport` resolves each name and refuses resolved addresses that are
not public, such as loopback, private and link-local ones, unless
`allow_private_addresses`. It speaks TLS for `secureTransport: "on"` with
rustls and the `ring` provider, verifying servers against the
`webpki-roots` certificates or a `rustls::ClientConfig` given to
`with_tls_config`, and for `"starttls"` performs the same handshake when
JavaScript calls `startTls()`. It relays bytes on the Tokio runtime that
polls the host pump: JavaScript's end of writes shuts down the
connection's write half, the peer's end of its bytes ends JavaScript's
readable, the socket closes normally once both have ended, a connection or
handshake error closes it with 1011, and the end of the invocation drops
the connection. `tests/sockets.rs` checks it against local plain, TLS and
STARTTLS servers on every engine.

## Client WebSockets

With the `websocket` feature, `WebSocketClient` opens the
connections of JavaScript's global `WebSocket` for a `WebSocketService`,
whose `FetchPolicy` names the origins JavaScript may reach, `ws:` and `wss:`
counting as `http:` and `https:`
([host services](../../docs/host-services.md#client-websockets)):

```rust,ignore
use fetchlet::{FetchPolicy, HostServices, WebSocketService};
use fetchlet_net::WebSocketClient;

let policy = FetchPolicy::deny_all().allow_origin("https://chat.example.com")?;
let hosts = HostServices::new().websockets(WebSocketService::new(WebSocketClient::new(), policy));
```

`WebSocketClient` resolves and checks addresses as `TcpTransport` does and
speaks TLS for `wss:` with the same configuration. tungstenite performs
the opening handshake, with the subprotocols JavaScript requested, the
service's credential headers and no extensions, then the framing, pings and
the closing handshake on the Tokio runtime that polls the host pump.
`Limits::channel_message_bytes` bounds each message and frame from the
server, and a larger one closes the socket with 1009. A failed handshake
fires `error` and `close` with 1006 in JavaScript, as does a connection
that ends without a closing handshake. `tests/websocket.rs` checks it
against local `ws:` and `wss:` servers on every engine.

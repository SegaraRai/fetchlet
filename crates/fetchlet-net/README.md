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

```sh
cargo add fetchlet --features quickjs
cargo add fetchlet-net
```

`rustls` is re-exported for TLS configurations given to `with_tls_config`.

## Documentation

The guide to this crate is at <https://fetchlet.roundtrip.dev/docs/rust/fetchlet-net>, and its API reference
is on [docs.rs](https://docs.rs/fetchlet-net). The fetchlet documentation starts at
<https://fetchlet.roundtrip.dev/docs>.

A JavaScript application that installs the `fetchlet` npm package also has
this documentation as Markdown in `node_modules/fetchlet/docs/`, where coding
agents can read the version that the application uses
([Coding agents](https://fetchlet.roundtrip.dev/docs/agents)).

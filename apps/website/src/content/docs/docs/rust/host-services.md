---
title: "Host services"
slug: docs/rust/host-services
description: "Grant JavaScript environment values, Rust functions, channels, sockets, console output, and outbound fetch."
---

`HostServices` defines every capability your Rust host grants to JavaScript:
environment values, Rust functions, bidirectional channels, outbound `fetch()`,
TCP sockets, WebSockets, and a console sink. Without explicit configuration,
JavaScript has no access to the network or host environment.

## Bindings

```rust
use fetchlet::{
    App, Backend, Body, FetchPolicy, FetchService, HostServices,
    Module, Response, transport_fn,
};

let policy = FetchPolicy::deny_all()
    .allow_origin("https://api.example.test")?;

let service = FetchService::new(
    transport_fn(|request| async move {
        let message = format!("handled {}", request.uri().path());
        Ok(Response::new(Body::from(message)))
    }),
    policy,
);

let hosts = HostServices::new()
    .outbound(service.clone())
    .service("API", service)?
    .env("APP_ENV", "production")?;

let mut app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .host_services(hosts)
    .build()?;
```

In JavaScript, these appear on `fetchlet.env` (or via `getBindings()` from
`fetchlet/runtime/adapter`, and on your framework's request context):

- `fetch(url, init)` calls `outbound`
- `env.API.fetch(url, init)` calls the named service `"API"`
- `env.APP_ENV` reads `"production"`

Bindings are read-only and fixed before modules evaluate. Only expose values
JavaScript needs to read — keep upstream API keys and tokens in Rust using
`FetchService::credentials()`.

For real network requests over HTTP/1.1 and HTTP/2, pass `fetchlet_net::HttpClient`
as the transport ([Outbound networking](/docs/rust/fetchlet-net)).

## Function bindings

`HostServices::functions(name, functions)` exposes Rust functions directly on
`env` so JavaScript can call Rust without constructing an HTTP `Request`:

```rust
use fetchlet::{FunctionError, FunctionRequest, Functions, HostServices};
use serde_json::{Value, json};

let db = Functions::new()
    .method("query", |request: FunctionRequest| async move {
        let (sql, params): (String, Vec<Value>) = request.args()?;
        let user = request.context().get::<User>();
        let rows = run(user, &sql, &params)
            .await
            .map_err(|error| FunctionError::new(error.to_string()).code("QUERY_FAILED"))?;
        Ok(json!(rows))
    })
    .sync_method("escape", |request: FunctionRequest| {
        let (text,): (String,) = request.args()?;
        Ok(json!(escape(&text)))
    });

let hosts = HostServices::new().functions("DB", db)?;
```

```js
const rows = await env.DB.query("select 1", []);
const quoted = env.DB.escape(name);
```

- **Values and binary data:** arguments and results are JSON (bounded by
  `Limits::bridge_message_bytes`). Any `ArrayBuffer` or view (`Uint8Array`, Node
  `Buffer`) transfers directly as raw bytes without JSON encoding, and
  deserializes into `Vec<u8>` or `bytes::Bytes`. Return raw bytes directly or
  embed them inside JSON with `FunctionResponse::bytes_at`.
- **Returning channels:** `FunctionResponse::channel_at(pointer, request.limits())`
  attaches a live `HostChannel` inside the return value:

```rust
use fetchlet::{FunctionRequest, FunctionResponse, Functions};

let events = Functions::new().method("subscribe", |request: FunctionRequest| async move {
    let (topic,): (String,) = request.args()?;
    let mut response = FunctionResponse::new(json!({ "topic": topic, "events": null }));
    let end = response.channel_at("/events", request.limits())?;
    tokio::spawn(publish(topic, end));
    Ok(response)
});
```

```js
const { events } = await env.EVENTS.subscribe("news");
const socket = events.socket();
socket.addEventListener("message", (event) => console.log(event.data));
```

- **Async vs. sync methods:** async methods return a `Promise`, respect
  `Limits::timeout`, and cancel when the invocation ends. Sync methods block the
  JS thread and cannot be interrupted by a deadline, so keep them to fast
  in-memory work.
- **Errors:** invalid arguments throw a `TypeError` (hiding Serde internals);
  `FunctionError::new(msg).code(code)` arrives as a JS `Error` with `code`;
  panics fail the call with `PANICKED` without crashing the instance.
- **Context & limits:** read the trusted `Context` via `request.context()`.
  Calling the same `AppHandle` recursively fails with `Error::Reentrant`.
  `Limits::function_calls` caps calls per invocation.

## Channels

`HostServices::channel(name, service)` lets JavaScript open bidirectional
message or byte streams via `env.NAME.connect(options)`:

```rust
use fetchlet::{ChannelRequest, CloseFrame, HostServices, channel_fn};

let hosts = HostServices::new().channel(
    "PROGRESS",
    channel_fn(|request: ChannelRequest| async move {
        let mut end = request.end;
        tokio::spawn(async move {
            for step in 1..=3 {
                if end.send(format!("step {step}")).await.is_err() {
                    return;
                }
            }
            end.close(CloseFrame::new(CloseFrame::NORMAL, "done"));
        });
        Ok(())
    }),
)?;
```

- `ChannelEnd` implements `futures::Stream<Item = ChannelEvent>` and
  `futures::Sink<Message>`, with backpressure bounded by `Limits::open_channels`,
  `channel_message_bytes`, and `channel_buffer_bytes`.
- On the JavaScript side, consume the channel with `channel.socket()`
  (WebSocket-style messages) or `channel.stream()` (`{ readable, writable }`
  byte streams).
- Channels close automatically (code `1006`) when their invocation ends.

## Calls with bytes, channels and context

When Rust invokes an exported JavaScript function with `App::call_with` or
`AppHandle::call_with`, `Call` lets you pass raw byte arrays, live channels, and
a trusted `Context`:

```rust
use fetchlet::{Call, ChannelEvent};
use serde_json::json;

let mut call = Call::new("transcode");
call.json(json!({ "format": "webm", "progress": null }));
let mut progress = call.channel_at("/0/progress", app.limits())?;
let mut input = call.channel(app.limits());

let (result, _) = tokio::join!(app.call_with(call), async {
    input.send(chunk).await?;
    while let Some(ChannelEvent::Message(step)) = progress.recv().await {
        report(step);
    }
    anyhow::Ok(())
});
```

- `bytes()` / `bytes_at(pointer)` pass `Uint8Array` arguments without JSON
  encoding; `channel()` / `channel_at(pointer, limits)` pass `HostChannel`
  objects.
- `context(Context)` attaches trusted Rust values accessible to `Functions`
  methods and internal fetches called during that invocation.
- `CallOutput::deserialize::<T>()` reads both JSON fields and returned
  `Uint8Array` / `Buffer` values back into Rust types such as `Vec<u8>` or
  `bytes::Bytes`:

```rust
let mut call = Call::new("thumbnail");
call.bytes(image).json(json!({ "width": 128 }));
call.context(Context::new().with(Tenant("a".into())));
let (name, thumbnail): (String, Vec<u8>) = app.call_with(call).await?.deserialize()?;
```

## Sockets

`HostServices::sockets(service)` enables `connect(address, options)` from
`fetchlet/runtime` (WinterTC Sockets API) using a `SocketPolicy` allowlist and a
`SocketTransport` (such as [`fetchlet_net::TcpTransport`](/docs/rust/fetchlet-net#outbound-tcp--tls-tcptransport)
or a custom `socket_fn`):

```rust
use fetchlet::{HostServices, SocketPolicy, SocketService};
use fetchlet_net::TcpTransport;

let policy = SocketPolicy::deny_all()
    .allow("db.example.com", 5432)?
    .allow_ports("cache.internal", 6379..=6380)?;
let transport = TcpTransport::new().allow_private_addresses();
let hosts = HostServices::new().sockets(SocketService::new(transport, policy));
```

- `SocketPolicy` matches exact normalized hostnames/IPs and port ranges; use
  `SocketService::rewrite` to map logical names before authorization and
  `forward_context` to pass the trusted `Context`.
- Sockets count against `Limits::open_channels`, `channel_message_bytes`, and
  `channel_buffer_bytes`, support half-close (`ChannelEvent::End`) and STARTTLS
  (`ChannelEvent::StartTls` / `ChannelEnd::confirm_tls`), and close when the
  invocation ends.

## Client WebSockets

`HostServices::websockets(service)` enables JavaScript's global `new WebSocket()`
with a `FetchPolicy` (`ws:` / `wss:` map to `http:` / `https:`) and a
`WebSocketTransport` (such as [`fetchlet_net::WebSocketClient`](/docs/rust/fetchlet-net#outbound-websockets-websocketclient)
or `websocket_fn`):

```rust
use fetchlet::{FetchPolicy, HostServices, WebSocketService};
use fetchlet_net::WebSocketClient;

let policy = FetchPolicy::deny_all().allow_origin("https://chat.example.com")?;
let service = WebSocketService::new(WebSocketClient::new(), policy)
    .credentials(|url, headers| {
        if url.host_str() == Some("chat.example.com") {
            headers.insert("authorization", "Bearer token".parse()?);
        }
        Ok(())
    });
let hosts = HostServices::new().websockets(service);
```

- `rewrite` runs before authorization; `credentials` runs after and attaches
  headers to the opening handshake without exposing them to JavaScript.
- Refused origins, failed handshakes, or missing services fire `error` and
  `close` (`1006`) in JavaScript. Sockets close when the invocation ends.

## Console

`HostServices::console` captures `console.debug`, `log`, `info`, `warn`, and
`error` calls. Frameworks like SvelteKit log server errors through
`console.error`, so wiring this up makes server-side failures visible:

```rust
let hosts = HostServices::new()
    .console(|level, message| eprintln!("[js {level:?}] {message}"));
```

Without a callback, console output is discarded. Messages larger than
`Limits::bridge_message_bytes` are replaced with
`[fetchlet: console message dropped]`. Because the callback runs on the
JavaScript thread, offload slow I/O to another task or channel.

## Outbound fetch lifecycle

Every `fetch()` call from JavaScript runs through `FetchService` in a fixed
order:

1. **Read or stream request body** (checking `request_body_bytes`,
   `request_body_chunks`, and `bridge_message_bytes`).
2. **Count subrequest** against `Limits::subrequests` and select the target
   service (`outbound` or named binding).
3. **Rewrite** — optional `FetchService::rewrite` callback may modify the
   request.
4. **Authorize** — check the rewritten origin, method, headers, and body against
   `FetchPolicy`.
5. **Attach credentials** — optional `FetchService::credentials` callback adds
   secrets for this single hop only.
6. **Send** — invoke the single-hop `FetchTransport`.
7. **Redirects** — rebuild the next request from the pre-credential request and
   repeat steps 3–6 (cross-origin redirects also strip guest `Authorization` and
   `Cookie` headers).

To route specific origins to in-process Rust handlers or an axum router without
opening a socket, use `OriginRouter` ([In-process fetch](/docs/rust/in-process-fetch)).

## Streaming request bodies

An outbound `fetch()` whose body is a `ReadableStream` (with `duplex: "half"`)
streams chunks on demand to the transport without buffering the whole payload:

- Any redirect other than `303` fails with `TRANSPORT` (because the stream
  cannot be replayed); `redirect: "manual"` returns the redirect response.
- Network transports require HTTP/2 (`RequireHttp2`) unless the policy enables
  `FetchPolicy::allow_http1_streaming()`. In-process transports ignore this
  requirement.
- `request_body_bytes`, `request_body_chunks`, and `bridge_message_bytes` are
  enforced per chunk; aborting the fetch or early server responses cancel the
  JavaScript stream.

## Writing a custom `FetchTransport`

If you implement `FetchTransport` directly (instead of using `HttpClient`,
`transport_fn`, or `router_transport`):

- Handle a single HTTP hop and return redirect responses to `FetchService`.
- Cancel in-flight work when your future or returned `Body` is dropped.
- Enforce `response_body_bytes` while receiving and honor `RequireHttp2` on
  network connections.
- Validate DNS resolution and destination IP addresses for network reachability.

When spawning background tasks inside a transport (such as connection pools),
configure `AppBuilder::host_runtime(handle)` so they continue running on a
shared Tokio runtime while an instance executes JavaScript
(`fetchlet_http::Server` sets this automatically).

## Related guides

- [In-process fetch](/docs/rust/in-process-fetch): call Rust handlers and axum routers via `OriginRouter`
- [Outbound networking](/docs/rust/fetchlet-net): `HttpClient`, `TcpTransport`, and `WebSocketClient`
- [Resource limits](/docs/rust/resource-policy): every `Limits` field and its scope
- [Running JavaScript](/docs/rust/fetchlet): `App`, `AppHandle`, pools, and process isolation

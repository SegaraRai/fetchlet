# Host services

`HostServices` is the authority an app receives from Rust: environment
values, named services, channel services, Rust functions, outbound fetch
and a console sink. This page covers
configuring them and the contracts they keep.

## Bindings

```rust,ignore
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

JavaScript uses `fetch(url, init)`, `fetchlet.env.API.fetch(url, init)` and
`fetchlet.env.APP_ENV`. `getBindings()` from `fetchlet/runtime/adapter`
returns the same object. The bindings are a read-only, null-prototype
object installed before the module is evaluated. Rust decides every value
and service in it. Pass JavaScript only what it must read; keep upstream
credentials in Rust, in the service's credentials callback.

For the network, fetchlet-net's `http` feature provides `HttpClient`, a
transport over hyper that speaks HTTP/1.1, and HTTP/2 when a TLS server
selects it, pools connections per origin, decodes gzip, deflate and Brotli
responses as a browser does, resolves each host and refuses non-public
addresses unless `allow_private_addresses`:

```rust,ignore
use fetchlet::{FetchPolicy, FetchService, HostServices};
use fetchlet_net::HttpClient;

let policy = FetchPolicy::deny_all().allow_origin("https://api.example.com")?;
let hosts = HostServices::new().outbound(FetchService::new(HttpClient::new(), policy));
```

`App` runs calls one at a time through `&mut self`. QuickJS and Boa run on
the caller's thread; V8 keeps a dedicated worker per isolate. `AppHandle`
manages the thread and queue itself.

## Channels

`HostServices::channel(name, service)` binds a `ChannelService` under a
name in `env`. JavaScript opens a channel with
`fetchlet.env.NAME.connect(options)`; the service receives the options as
JSON, the invocation's `Context` and Rust's `ChannelEnd`, and accepts or
refuses the open. `channel_fn` adapts an async function:

```rust,ignore
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

A channel carries text and binary messages both ways and ends in a close
with a WebSocket close code. It belongs to the invocation that opened it:
it stays open while the invocation's `waitUntil` work or response body
does, and Rust sees code 1006 when the invocation ends without closing it.
`Limits::open_channels` bounds the opens of one invocation,
`channel_message_bytes` one message, and `channel_buffer_bytes` the queue
in each direction; Rust's `send` waits for room. `ChannelEnd` is also a
`Stream` of `ChannelEvent`s and a `Sink` of `Message`s, whose `close`
flushes and closes with 1000, so `futures` combinators such as `send_all`,
`forward` and `split` work on it.

In JavaScript, `connect` returns a channel with `opened` and `closed`
promises and one of two views. `socket()` is a WebSocket of its messages.
`stream()` is a `readable` of the bytes of its binary messages and a
`writable` whose writes Rust queues as binary messages within the budgets;
a full reader holds Rust's messages back, so a slow reader slows the
service. The views come from the Web API profile, which
`fetchlet/runtime` installs. `ChannelBinding` in `fetchlet/bindings` types
the binding. The service's future is polled in the host pump, within the
host runtime, and must not call the same App again; what it spawns ends
when JavaScript's end goes away. `crates/fetchlet/tests/channels.rs`
checks the contract on all three engines, and the vanilla-axum example
streams a Rust job's progress as a response body.

## Sockets

`HostServices::sockets(service)` lets JavaScript open TCP connections with
`connect(address, options)` from `fetchlet/runtime`, the Sockets API of
WinterTC. A `SocketService` pairs a `SocketTransport` with the
`SocketPolicy` that authorizes each address:

```rust,ignore
use fetchlet::{HostServices, SocketPolicy, SocketService};
use fetchlet_net::TcpTransport;

let policy = SocketPolicy::deny_all()
    .allow("db.example.com", 5432)?
    .allow_ports("cache.internal", 6379..=6380)?;
let transport = TcpTransport::new().allow_private_addresses();
let hosts = HostServices::new().sockets(SocketService::new(transport, policy));
```

The policy matches exact normalized hosts, names lowercased and IP literals
in their canonical form, and ports or port ranges; it resolves nothing.
`SocketService::rewrite` changes an address before the check, such as to
map a name JavaScript knows to the host that serves it, and
`forward_context` passes the invocation's `Context` to the transport. An
address the policy refuses, an invalid one and a `connect` without a socket
service throw nothing in JavaScript: the socket's `opened` and `closed`
reject.

fetchlet-net's `sockets` feature provides `TcpTransport`. It resolves the
name, refuses every resolved address that is not public (loopback, private,
link-local, shared and other special-purpose ranges, including IPv4
addresses embedded in IPv6) unless `allow_private_addresses`, connects to
the first address that accepts, and speaks TLS for `secureTransport: "on"`,
verifying the server against the `webpki-roots` certificates or the
`rustls` configuration given to `with_tls_config`. `socket_fn` adapts an
async function, such as an in-process server or a mock, to a transport.

A socket is a channel of the invocation, viewed as a stream: it counts
against `Limits::open_channels`, its reads and writes are binary messages
within `channel_message_bytes` and `channel_buffer_bytes`, and it closes
when the invocation ends, after its `waitUntil` work and response body.

Two signals travel in order with a socket's bytes as `ChannelEvent`s:

- **End of writes.** Closing the writable sends `ChannelEvent::End`, a half
  close: the transport shuts down the connection's write half and keeps
  reading. When the peer's bytes end, the transport calls
  `ChannelEnd::finish` and the readable ends. Without `allowHalfOpen`, that
  also closes the writable, after the write in flight; with it, the
  writable stays open until JavaScript closes it. The transport closes the
  channel normally once both directions have ended, and a connection error
  rejects `closed`.
- **TLS upgrade.** A socket connected with `secureTransport: "starttls"`
  speaks plain TCP until `startTls()`, which returns a new socket and
  marks the old one `upgraded`: the old socket's streams end and its
  `closed` resolves, and after the plain bytes already written the
  transport receives `ChannelEvent::StartTls` (`SecureTransport::StartTls`
  in its request). It performs the handshake for the address's host and
  answers with `ChannelEnd::confirm_tls`, which resolves the new socket's
  `opened`; its writes wait for that. A failed handshake closes the
  channel with 1011.

The bridge accepts each signal only for an open socket with no write
pending and its writes not ended, and `startTls` once, for a socket opened
with `"starttls"`; channels of env bindings never receive them.
`crates/fetchlet/tests/sockets.rs` checks the contract on all three engines,
and `crates/fetchlet-net/tests/sockets.rs` checks `TcpTransport` against
local plain, TLS and STARTTLS servers, with a test certificate authority.

## Client WebSockets

`HostServices::websockets(service)` serves the global `WebSocket`: each
`new WebSocket(url, protocols)` opens through a `WebSocketService`, which
pairs a `WebSocketTransport` with the `FetchPolicy` that authorizes the
URL's origin, `ws:` and `wss:` counting as `http:` and `https:`:

```rust,ignore
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

The constructor checks the URL and subprotocols as the WebSockets standard
says and throws `SyntaxError` for an invalid one: `http:` and `https:` URLs
become `ws:` and `wss:`, and a fragment, invalid tokens and duplicates are
refused. The host checks them again, then applies `rewrite`, the policy,
and `credentials`, whose headers join the opening handshake without
JavaScript seeing them; `forward_context` passes the invocation's `Context`
to the transport. An origin the policy refuses, a failed handshake and a
`WebSocket` without a service fire `error` and then `close` with 1006, as a
connection that failed does.

The transport performs the opening handshake and settles with the server's
selection, a `WebSocketAccept` whose subprotocol and extensions become the
socket's `protocol` and `extensions`. It then relays text and binary
messages between the connection and the channel's end, answers
JavaScript's close with the closing handshake and reports the server's
close with `ChannelEnd::close`; a connection that ends without a closing
handshake drops the end, which JavaScript sees as 1006. `websocket_fn`
adapts an async function, such as an in-process server or a mock, to a
transport.

fetchlet-net's `websocket` feature provides `WebSocketClient`. It
resolves and checks addresses as `TcpTransport` does, refusing addresses
that are not public unless `allow_private_addresses`, speaks TLS for
`wss:` with the `webpki-roots` certificates or the configuration given to
`with_tls_config`, and uses tungstenite for the handshake and framing. It
asks for the subprotocols JavaScript requested and for no extensions, and
bounds each message and frame from the server by
`Limits::channel_message_bytes`, closing with 1009 for a larger one.

A client WebSocket is a channel of the invocation, viewed as messages: it
counts against `Limits::open_channels`, its messages stay within
`channel_message_bytes` and `channel_buffer_bytes`, and it closes when the
invocation ends. `crates/fetchlet/tests/websocket_client.rs` checks the
contract on all three engines, and
`crates/fetchlet-net/tests/websocket.rs` checks `WebSocketClient`
against local `ws:` and `wss:` servers.

## Console

The callback passed to `HostServices::console` receives each
`console.debug`, `log`, `info`, `warn` and `error` call as a `ConsoleLevel`
and one formatted line. Frameworks such as SvelteKit report server errors
with `console.error`, so forwarding them to Rust logs makes failures
visible.

```rust,ignore
let hosts = HostServices::new()
    .console(|level, message| eprintln!("[js {level:?}] {message}"));
```

Strings are kept as they are, errors become their stack (or name and
message), objects become JSON and other values `String(value)`; the parts
are joined with spaces. Each call is one bridge message; one larger than
`Limits::bridge_message_bytes` is replaced with
`[fetchlet: console message dropped]`. Console calls never throw into the
application. The callback runs on the JavaScript thread, so hand heavy work
to another thread or queue. Without a sink, console output is discarded.
`crates/fetchlet/tests/app.rs` checks the contract on all three engines.

## Bundle entry

A module is a built IIFE that puts its exports on `fetchletExports`.
`App::call` and `call_json` call any export; `fetch` calls the Fetch entry,
`handle` unless `AppBuilder::fetch_handler` names another. With
`fetch_handler(None)`, `fetch` fails with `Error::Configuration` before
running JavaScript, for a module of functions only.

The Fetch entry converts the URL, method, header pairs and body into a Web
`Request` and converts the returned `Response` back.
`createFetchHandler` in `fetchlet/runtime/adapter` builds one from a
standard handler; the framework adapters in the `fetchlet` package build
their entries with it. `fixtures/hono.tsx` and `fixtures/sveltekit/entry.ts`
are small examples.

`App::fetch_with_context(request, &context)` passes a Serde value as the
entry's second argument. `fetchlet-http` uses it for
`RequestContext { clientAddress }`.

## Calls with bytes, channels and context

`App::call_with` and `AppHandle::call_with` take a `Call`, whose arguments
are JSON values, byte arrays and channels Rust lends to the call, and which
may carry the invocation's trusted `Context`:

```rust,ignore
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

`channel` adds a channel as the next argument; `channel_at` puts one at a
JSON Pointer into the argument list, which must name an existing value
outside the other lent positions, and fails with `InvalidRequest`
otherwise. Rust keeps each `ChannelEnd`; JavaScript receives a channel
object, with the `opened`, `closed`, `socket()` and `stream()` of an env
binding's channel, as a data property at that position. The channel
belongs to the call's invocation and closes when it ends, with 1006 if
neither side closed it. It takes its budgets from the `Limits` passed in,
the App's in the example, and does not count against `open_channels`,
which bounds what JavaScript opens. The channel objects come from the Web
API profile; a call that lends channels to a bundle without it fails.
`crates/fetchlet/tests/call_channels.rs` checks the contract on all three
engines.

`bytes` adds a byte array as the next argument and `bytes_at` puts one at a
JSON Pointer, with the same rules as `channel_at`; JavaScript receives a
`Uint8Array` there. The bytes are copied once into the engine and never
encoded as JSON; their size is the caller's to bound. `context(Context)`
attaches trusted values to the call's invocation, which reach the
`Functions` methods JavaScript calls as `FunctionRequest::context` and its
host fetches as the context of a Fetch request does. JavaScript cannot
read them.

`call_with` returns a `CallOutput`: the result as `JSON.stringify` encodes
it, except that each `ArrayBuffer` or view, a Node `Buffer` included,
crosses as its bytes and the value holds `null` there. `bytes_at(pointer)`
finds one, the empty pointer naming a result that is itself a byte array,
and `deserialize::<T>()` reads them where they were into `Vec<u8>` or
`bytes::Bytes` with its `serde` feature, as `FunctionRequest::args` does.
The byte arrays of a result travel in one buffer, which
`Limits::bridge_message_bytes` bounds. `call` deserializes the same way;
`call_json` returns the JSON value alone.

```rust,ignore
let mut call = Call::new("thumbnail");
call.bytes(image).json(json!({ "width": 128 }));
call.context(Context::new().with(Tenant("a".into())));
let (name, thumbnail): (String, Vec<u8>) = app.call_with(call).await?.deserialize()?;
```

`crates/fetchlet/tests/call_values.rs` checks byte arrays both ways and the
context on all three engines. A channel JavaScript holds cannot yet be
returned from a call or passed to a method; see
[the next work](TODO.md#moving-javascript-channels-to-rust).

## Function bindings

`HostServices::functions(name, functions)` binds Rust functions under a
name in `env`, which they share with env values, services and channels.
JavaScript calls them as methods without building a `Request`:

```rust,ignore
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
const rows = await fetchlet.env.DB.query("select 1", []);
const quoted = fetchlet.env.DB.escape(name);
```

`env.DB` is a frozen, null-prototype object with exactly the registered
methods. A method named `then`, which would make the binding a thenable,
and a name added twice fail with `Configuration` when bound.

- **Values.** Arguments arrive as the JSON array `JSON.stringify` makes of
  them, so `undefined` becomes `null` and a `BigInt` throws its
  `TypeError` before Rust runs. `request.args::<T>()` deserializes them with
  serde, usually into a tuple with one element per argument, which needs
  exactly that many; `Vec<Value>` takes any number, and `raw_args` gives
  the array. A result is any JSON value. Both directions are bridge
  messages, so `Limits::bridge_message_bytes` bounds each; a result over it
  fails the call with `LIMIT_EXCEEDED`.
- **Byte arrays.** An `ArrayBuffer` or view, such as a `Uint8Array` or a
  Node `Buffer`, anywhere in the arguments crosses as its bytes, copied
  once and never encoded as JSON. `args` reads it where it was passed into
  `Vec<u8>`, `bytes::Bytes` with its `serde` feature, or another type that
  deserializes from bytes; `raw_args` shows `null` there. The byte arrays
  of one call travel as one buffer, which `bridge_message_bytes` bounds.
  A method returns bytes as its whole result with `Bytes` or `Vec<u8>`, or
  places them inside a JSON value with `FunctionResponse::bytes_at`, and
  JavaScript receives each as a `Uint8Array`.
- **Channels.** `FunctionResponse::channel_at(pointer, request.limits())`
  lends a channel at a position of the result and returns Rust's
  `ChannelEnd`, as `Call::channel_at` does for an export's arguments.
  JavaScript receives a channel object with `opened`, `closed`, `socket()`
  and `stream()`; it belongs to the invocation, closes when the invocation
  ends with 1006 if neither side closed it, and does not count against
  `open_channels`. The objects come from the Web API profile; without it
  the call throws a `TypeError`.

```rust,ignore
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
const { events } = await fetchlet.env.EVENTS.subscribe("news");
const socket = events.socket();
socket.addEventListener("message", (event) => console.log(event.data));
```

- **Errors.** Arguments that `args` cannot deserialize throw a `TypeError`
  naming the binding and method, such as `Invalid arguments for DB.query`;
  serde's detail stays in Rust. `FunctionError::new(message)` arrives as an
  `Error` with that message and, with `.code(code)`, its `code`. A fetchlet
  `Error` converts with `?` and arrives as other host errors do, as a
  `FetchletHostError` with its generic `code` and message only. A method
  that panics fails its call with code `PANICKED`, and the instance stays
  usable.
- **Async methods** return a Promise. Their futures are polled with the
  invocation's other host operations, in the host runtime when one is set;
  the invocation's `timeout` covers them, and they are dropped when the
  invocation ends, so a call left running is cancelled.
- **Sync methods** return their result at once and block JavaScript, on the
  thread that runs the instance, while they run. No deadline interrupts
  them, so keep them to quick work such as lookups in memory, validation or
  formatting; anything that waits belongs in an async method.
- **Context and reentrancy.** `request.context()` is the trusted `Context`
  attached to the invocation's request, empty when there is none, and
  `request.method()` names the method called. A method that calls its own
  `AppHandle` fails with `Error::Reentrant`, as a host fetch does.
- **Budget.** `Limits::function_calls` bounds the calls of one invocation,
  sync and async, failed ones included.

A method returns any type that converts into `FunctionResponse`, such as
`Value`, `Bytes` or `Vec<u8>`; one whose body only fails names the type, as
in `Err::<Value, _>(error)`.

`crates/fetchlet/tests/functions.rs` checks the contract on all three
engines.

## Calling Rust in-process

The `transport_fn` above answers with a Rust function directly. Registered
as `outbound`, it serves global `fetch`; registered as a service, it serves
`fetchlet.env.API.fetch`. No HTTP connection or listening socket is needed,
and the same authorization and budgets apply.

`OriginRouter` selects a transport by exact origin and builds a service that
allows only the registered origins. Internal routes receive the `Context`
from the extensions of the request given to `App::fetch`. Internal origins
are ordinary `https://` origins under the private `.internal` domain; the
examples use `https://fetchlet.internal`, and an application can choose its
own names or register several. `fetchlet_http::router_transport` lets one
axum router serve both public HTTP and in-process fetches. Calling the same
`AppHandle` while one of its host fetches is running fails with
`Error::Reentrant`. [In-process fetch](in-process-fetch.md) has the details.

## Fetch processing order

1. Read a JavaScript request body that has a source, such as bytes, a
   string or a `Blob`, and check the body, chunk and message budgets. A
   `ReadableStream` body streams instead (see below).
2. Count a subrequest against the invocation and select the service.
3. Let the Rust rewrite callback change the request.
4. Check the rewritten origin, method, headers and body.
5. Attach credentials with the credentials callback and normalize transport
   headers.
6. Run the single-hop transport.
7. To follow a redirect, build the next request from the request before
   credentials and run the same checks.

Origins match exactly after normalizing scheme, host and port. Headers added
by the credentials callback live for one send. A redirect to another origin
also removes guest-supplied `Authorization`, `Cookie` and similar headers.

`FetchService::rewrite` runs before authorization and `credentials` after
it, so the credentials callback can restrict each secret to the URL it is
given.

## Streaming request bodies

A request body given as a `ReadableStream`, which needs `duplex: "half"`,
streams as the transport sends it, as Chrome and Firefox stream it: the
transport reads each chunk as JavaScript produces it, so neither side holds
the whole body. Such a body has no source to read again, and fetchlet
follows the Fetch Standard's rules for it, which those browsers implement:

- A redirect other than 303 fails the fetch with `TRANSPORT`, since it would
  resend the body; a 303 continues as a `GET` without it. `redirect:
  "manual"` returns the redirect as usual.
- `keepalive` and a mode other than `cors` or `same-origin` throw a
  `TypeError` when the `Request` is built.
- The body goes over HTTP/2 or later only. `FetchService` marks the request
  with `RequireHttp2`, and a network transport must not send it over
  HTTP/1.x; `HttpClient` then uses only an HTTP/2 connection and fails with
  `TRANSPORT` otherwise, plain `http:` included. A policy built with
  `FetchPolicy::allow_http1_streaming()` lets it use HTTP/1.1 with chunked
  transfer coding, for servers known to accept it. Transports that answer
  in-process have no connection and ignore the mark.

`request_body_bytes` counts the bytes as the transport reads them and
`request_body_chunks` the chunks JavaScript writes; `bridge_message_bytes`
bounds each chunk. A body that exceeds them, or whose stream errors, fails
the fetch. When the transport stops reading, as when the server answers
early or the fetch is aborted, the JavaScript stream is cancelled. A body
with a source is still read first, so a redirect can resend it; an incoming
request's body, which is a stream, streams when a handler forwards it.
`FetchService::fetch` from Rust applies the same rules to a `Body` that
streams.

## Transport contract

A transport is a trusted Rust implementation. It must answer a single hop,
stop work when its future is dropped and enforce the body budget while
receiving. A real HTTP client must also check DNS results and the address it
connects to: the origin policy authorizes URLs, and the transport controls
network reachability. A network transport must also honor
`RequireHttp2` ([streaming request bodies](#streaming-request-bodies)).
`HttpClient` keeps this contract: it returns
redirects to the caller, checks the resolved addresses of each new
connection, and stops when its future or body is dropped.

The invocation polls the transport future directly and wakes the engine on
the future's waker or the next JavaScript timer; there is no periodic
polling.

A transport may return a streaming body (`Body::from_http_body`). A guest
fetch reads it on demand as a `ReadableStream` and checks
`response_body_bytes` against the declared length and the running total.
Cancelling or aborting in JavaScript, or ending the invocation, drops the
body and cancels the transport. `FetchService::fetch`, called from Rust,
collects the body within the budget.

## Bodies and lifetime

The public types are `http::Request<Body>` and `http::Response<Body>`.
`Body` implements `http_body::Body` and holds a buffer, a stream from the
worker, or any wrapped `http_body::Body`. Binary bodies and repeated
`Set-Cookie` headers are preserved.

When an invocation ends it drops its transport futures synchronously. After
a normal completion, or a JavaScript exception with nothing pending, the
instance is reused. A dropped Rust future, an expired deadline or a return
with host fetches still pending retires it; `App::is_reusable()` reports
this, and calls on a retired `App` fail with `InstanceUnavailable`.
`AppHandle` rebuilds the instance instead.

Host futures are polled on the thread that runs the instance, in the
context of its runtime. `AppBuilder::host_runtime(handle)` polls them in the
context of a shared runtime instead, so that what a transport spawns, such
as the connection task of a pooled HTTP client, keeps running while an
instance runs JavaScript. Other instances that reuse the connection then do
not wait for it ([instance pools](research/instance-pools.md#host-transport-tasks)).
fetchlet-http's `Server` passes its runtime when it is a multi-thread one.

Timers left when a call ends are discarded. A streaming body holds its
invocation until it completes or is cancelled, and work registered with
`fetchlet.waitUntil` keeps the invocation open within `background_timeout`
and `background_tasks` ([data flow](data-flow.md#background-work)).

## Budgets

`AppBuilder::limits(Limits)` sets budgets for the use case. Each field is an
`Option`; `None` leaves that budget to the surrounding server or process
supervisor, and every field defaults to `None`. Engine heap and stack
settings live in `QuickJsOptions` and `V8Options`. [Resource
policy](resource-policy.md) lists them with their scopes.

## Shared handles and HTTP

`AppBuilder::spawn` returns an `AppHandle` that clones share for functions,
Fetch and Fetch with context, with an explicit queue capacity
([crate README](../crates/fetchlet/README.md)).
[fetchlet-http](../crates/fetchlet-http/README.md) connects it to HTTP
servers; the same request handling contract runs against every layer.

| Feature | Adds                                                                     |
| ------- | ------------------------------------------------------------------------ |
| (none)  | `FetchletService` (Tower and `http` 1), in-process transport, `Artifact` |
| `hyper` | `HyperService`, with hyper 1 connections and the peer address            |
| `axum`  | `AxumService`, `ConnectInfo`, `router_transport`, `artifact_router`      |
| `actix` | `ActixService` for actix-web 4                                           |

## Tests

`vp run test:host` sends real JavaScript fetches through mock transports on
all three engines: permissions, binary POST, cookies, credentials,
redirects, rewrites, env, named services, abort and instance retirement.
Results are in [reference](reference/README.md#host-services). The
implementation is in `crates/fetchlet/src/host/`, `crates/fetchlet/src/bridge/`
and `crates/fetchlet/js-src/host-bridge/`, with Web API operations in
`crates/fetchlet-web/`; the runner is in `tools/lab/`.

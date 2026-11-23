# Research: host channels and resources

JavaScript in fetchlet reaches the network only through Rust: `fetch` sends
each request to a `FetchService` that the host configured and authorizes.
WebSocket, TCP sockets and other connections should follow the same rule.
This document designs four things:

- one host channel primitive that carries messages between JavaScript and
  Rust;
- the handle table behind it, which also gives function calls values beyond
  JSON;
- the two lifetimes a channel can have;
- the APIs built on channels: `connect()`, the client `WebSocket` and server
  upgrades.

It builds on [instance pools](instance-pools.md). It records the constraints,
the semantics chosen, the alternatives rejected and the order of work.

## Status

The handle table, request-scoped channels, `connect()`, the client
`WebSocket`, held connections and channels in call arguments (steps 1 to 5
and the argument half of step 6 of the [order of work](#order-of-work)) are
implemented, held connections for the axum and actix integrations:

- `HostServices::channel(name, service)` binds a `ChannelService`, and
  `env.NAME.connect(options)` opens a channel of it in the current
  invocation. `channel_fn` adapts an async function; the service gets the
  options, the `Context` and the `ChannelEnd` in a `ChannelRequest`, and
  its future settles the open in the host pump. `Limits::open_channels`
  bounds the opens of one invocation.
- `@fetchlet/web` builds the channel object, with `opened`, `closed`,
  `close()` and two views: `socket()`, a WebSocket over the message view,
  and `stream()`, a `readable` and `writable` of bytes. The bridge's env
  binding calls the profile through `__fetchletChannelViews`. The stream
  view writes with `channel.write`, which Rust splits into binary messages
  within the budgets and completes when all are queued, and a full reader
  pauses delivery with `channel.pause`, so Rust's sender waits.
- `HostServices::sockets` takes a `SocketService`, whose `SocketPolicy`
  authorizes exact hosts and port ranges after an optional rewrite, and
  `connect()` from `@fetchlet/web/sockets`, re-exported by
  `fetchlet/runtime`, opens a channel of it with the `socket.open`
  operation and takes its stream view. fetchlet-net's `sockets` feature
  provides `TcpTransport`, which refuses non-public resolved addresses
  unless allowed and speaks TLS with rustls, from the start or after
  `startTls()`. A socket's end of writes and its TLS upgrade travel in
  order with its bytes as `ChannelEvent::End` and `ChannelEvent::StartTls`,
  through the `socket.end` and `socket.startTls` operations, so half-open
  sockets and STARTTLS need no second channel.
- `HostServices::websockets` takes a `WebSocketService`, whose `FetchPolicy`
  authorizes each URL's origin after an optional rewrite and whose
  credentials hook adds handshake headers. The global `WebSocket` opens a
  channel of it with the `websocket.open` operation and takes the message
  view; the open's arrival carries the server's subprotocol and extensions.
  fetchlet-net's `websocket` feature provides `WebSocketClient`,
  which shares `TcpTransport`'s address checks and TLS and runs tungstenite
  over them.
- A request-scoped channel closes when its invocation ends, after its
  `waitUntil` work and an open response body. The bridge forgets an upgrade
  the handler did not return when the handler returns, and the
  invocation's other channels when it ends.
- `ChannelEnd` implements `Stream` of `ChannelEvent` and `Sink` of
  `Message`. The sink holds one message while it waits for room; a `send`
  dropped while it waits keeps its message, which goes out before the next.
- `Call` lends channels to a function call: `call.channel(limits)` adds one
  as the next argument and `call.channel_at(pointer, limits)` puts one at a
  JSON Pointer into the arguments, which must name an existing value apart
  from the other lent positions. `App::call_with` and
  `AppHandle::call_with` enter each in the invocation's table, where it
  opens at the next poll, and the bridge places the channel object from
  `__fetchletChannelViews.lend` there as a data property before it calls
  the export. A lent channel closes with the invocation, as a
  request-scoped channel does, and does not count against
  `Limits::open_channels`.

- `Instances::max_held_connections` bounds held connections, and
  `AppHandle::reserve_connection` takes one place as a `HeldConnection`
  that the request carries in its extensions. `App::fetch` accepts an
  upgrade only for a `GET` that asks for `websocket` and carries a place.
- `upgradeWebSocket` from `fetchlet/runtime` (`@fetchlet/web/websocket`)
  returns the socket and the response. The `http::Response` that Rust gets
  is a 101 with a `ServerWebSocket` extension, from which the caller takes
  the `ChannelEnd`. The response carries its channel under a registered
  symbol, so the wire encoder finds it when a framework build bundles
  another copy of the module; `upgradeResponse` rebuilds it for a
  framework that copies responses, as Qwik City does.
- Body sources and channels share the invocation's handle table
  (`bridge/handles.rs`), as designed below. The bridge operations are
  `websocket.upgrade`, `channel.send`, `channel.close` and
  `channel.buffered`. Arrivals come with the completions of `fetch.poll`.
- `Limits::channel_message_bytes`, `channel_buffer_bytes`,
  `connection_idle_timeout` and `connection_lifetime` apply as designed
  below. A JavaScript message over either byte budget closes the channel
  with 1009. Shutdown closes held connections with 1001.
- fetchlet-http's `axum-websocket` feature completes the handshake in
  `AxumService` and relays frames. With every place taken, it answers 503
  before JavaScript runs. With `max_held_connections` at 0, the handler
  sees upgrade requests as ordinary requests, and `upgradeWebSocket`
  throws.

Framework support: Hono's helper (`fetchlet/hono/websocket`), Nitro's
`defineWebSocketHandler` through crossws's Deno adapter in the fetchlet
preset, and route handlers that return `upgradeWebSocket`'s response in
Astro, React Router, SvelteKit, Qwik City, Solid, SolidStart, TanStack
Start, vinext and Waku. Each axum example checks a socket held on one of two
instances while the other serves requests.

Tests: `crates/fetchlet/tests/websocket.rs` on every engine,
`crates/fetchlet-http/tests/axum_websocket.rs` over a real socket, the handle
table's tests in `bridge/handles.rs` and `bridge/tests.rs`, the
`bridge_bodies` fuzz target, and the examples' end-to-end checks.
Request-scoped channels are tested in `crates/fetchlet/tests/channels.rs` on
every engine, `packages/web/tests/channel.test.ts` and the vanilla-axum
example's progress routes. Sockets are tested in
`crates/fetchlet/tests/sockets.rs` on every engine,
`crates/fetchlet-net/tests/sockets.rs` against a local TCP server and
`packages/web/tests/sockets.test.ts`; client WebSockets in
`crates/fetchlet/tests/websocket_client.rs` on every engine,
`crates/fetchlet-net/tests/websocket.rs` against local `ws:` and
`wss:` servers and `packages/web/tests/websocket.test.ts`. fetchlet-http's
`actix-websocket` feature completes upgrades in `ActixService` with
actix-ws, tested in `crates/fetchlet-http/tests/actix_websocket.rs`, and
`ViteDev` passes upgrade requests to the app, which the `vite dev` loops of
the examples check. Lent channels are tested in
`crates/fetchlet/tests/call_channels.rs` on every engine and
`packages/web/tests/channel.test.ts`. Results stay JSON. The channel object
keeps its handle in a private field, but the bridge's registry, which
`@fetchlet/web` reaches as a global, still takes numeric handles.

## Constraints

- **An instance runs one invocation at a time.** JavaScript runs only inside
  an invocation: a call, a Fetch request, a pull of a response body, or the
  settling of `waitUntil` work. Between invocations no event loop runs, and
  `clearInvocation` drops the timers of an invocation that has no
  background work. A pool keeps this rule and adds instances.
- **Host state is scoped to the invocation.** `InvocationState` in
  `bridge/dispatcher.rs` owns the byte store, the body sources, the pending
  fetches and reads, and the Web API state. Dropping `InvocationScope`
  releases all of it. Host operations are attributed to the instance's one
  active invocation, which carries its `Context`, its budgets and its
  disconnect token.
- **The host pump delivers completions.** `pumpHostOperations` calls
  `fetch.poll` between microtasks. Rust polls each pending future with the
  engine's `WakeSignal` and returns the completed tickets as one batch.
- **Application code cannot call host operations.** The bridge takes the
  native dispatch off the global object, and `SEAL_HOST` removes
  `__fetchletClaimHost` before the application evaluates.
  `tests/guest_isolation.rs` checks this. Identifiers that cross the bridge
  are therefore protected from the bridge's own mistakes, not from
  application code that forges numbers.
- **JavaScript state lives in one instance.** Closures, listeners and
  module state cannot move to another instance, and a retiring instance
  loses them.
- **No async context on QuickJS yet.** Attributing host operations to one of
  several invocations running at once in one instance needs an async
  context that every engine carries through promise jobs
  ([async context](async-context.md)). Anything that needs that waits for
  it.

## Decisions

- A channel is always owned by one invocation. It closes when that
  invocation ends.
- **Request-scoped** is the default lifetime. A channel opened by
  JavaScript belongs to the current invocation and closes when the
  invocation ends.
- **Held connections** serve server WebSockets. The invocation that accepts
  the upgrade stays open until the connection closes, holding its instance,
  as an open response body does. One connection holds one instance. A pool
  serves other requests on its other instances and bounds the held ones.
- Several connections per instance, and channels that outlive their
  invocation, need async context or state outside JavaScript. They wait
  until async context is available on every engine.

## Handles

A handle is a reference from JavaScript to something Rust owns: a body
source or a channel. Both live in one handle table in `InvocationState`
(`bridge/handles.rs`). Every resource JavaScript can reach belongs to an
invocation; the table's slots outlive it only as empty slots with their
generations.

- **Identifiers.** A handle is a slot index (20 bits) and the slot's
  generation (33 bits), packed into an integer below 2^53, so a JavaScript
  number carries it exactly, as byte handles are carried. Releasing a slot
  increments its generation, so a stale identifier names nothing instead of
  a newer resource. The end of an invocation releases every entry, so an
  identifier from an earlier invocation never resolves. A slot whose
  generation runs out is retired, and an invocation holds at most 2^20
  entries at once.
- **Kinds.** Each entry has a kind: body source, channel, and later others.
  An operation names the kind it expects, and a handle of another kind fails
  with `InvalidRequest`, as an unknown body does now.
- **Release.** Closing a resource removes its entry and drops the Rust
  value, which cancels its producer. Ending the invocation drops every
  entry. Release is idempotent, as `body.cancel` is.
- **Budgets.** `Limits::open_channels` bounds the channels of one
  invocation, as `subrequests` bounds its fetches. Both are caller budgets.
- **Wrappers.** Application code never sees a numeric handle. The bridge
  wraps each handle in an object whose identifier is a `#` private field.
  Its methods are the only path to the host operations for that handle. A
  closed wrapper clears its identifier, so later calls throw instead of
  reaching Rust. No `FinalizationRegistry` is needed: the invocation's end
  is a deterministic release point.

### Values beyond JSON

Function arguments carry channels and results are JSON. The handle table
lets both carry resources without reserving any JSON shape that application
data could collide with:

- **Arguments** (implemented). A Rust caller builds a call from positional
  values that are either JSON or channels, `call.json(value)` and
  `call.channel(limits)`, which returns Rust's end. Channels nested inside
  a JSON value are listed out of band as JSON Pointer paths,
  `call.channel_at("/0/progress", limits)`. The bridge enters each channel
  in the invocation's table and places its channel object at its path
  before it calls the export.
- **Results.** The bridge serializes a result with a replacer that
  recognizes its own wrappers by their private brand. It writes `null` at
  each such position and lists the paths beside the JSON. Rust receives the
  value and the resources separately. A plain object that happens to look
  like a marker stays plain data.
- **Ownership.** A channel passed into a call is lent to that invocation
  and closes when it ends, with code 1006 if JavaScript did not close it,
  as a channel JavaScript opens does. Rust keeps its end throughout, so it
  needs nothing back. A resource in the result moves to Rust and detaches
  its wrapper, as transferring an `ArrayBuffer` detaches it.

Rust embedders get typed resources without each application inventing an
ownership protocol. This answers [values beyond JSON](../TODO.md#values-beyond-json).

## Channels

A channel is a bidirectional sequence of messages between JavaScript and a
Rust peer, ending in a close.

- **Messages.** A message is text (a string) or binary (bytes). Binary
  payloads cross the bridge through the byte store, as body chunks do.
  `Limits::channel_message_bytes` bounds one message. It is a caller budget:
  neither RFC 6455 nor TCP sets a maximum.
- **Close.** Either side closes with a code and a reason, using WebSocket's
  code space. The other side sees the close once, after the messages sent
  before it. An abnormal end, such as a dropped Rust peer, a transport error
  or the end of the invocation, arrives as code 1006 or 1011 with a reason.
  A channel that has seen a close accepts no further messages.
- **Backpressure.** Each direction has a bounded queue, measured in bytes by
  `Limits::channel_buffer_bytes`.
  - **Rust to JavaScript.** Rust's sender waits for capacity, so a slow
    reader slows the remote peer, through the TCP window for a socket. Rust
    delivers queued messages to JavaScript in the host pump, batched like
    completions.
  - **JavaScript to Rust.** The stream view's `write` resolves once the
    message is queued within the budget. The message view's `send` returns
    at once and counts the message in `bufferedAmount`, as WebSocket does;
    a `send` past the budget closes the channel with code 1009 instead of
    growing without bound.
- **Two views.** One channel offers two views:
  - a message view shaped like WebSocket, with `send`, `close`,
    `binaryType`, `readyState`, `bufferedAmount` and the `open`, `message`,
    `error` and `close` events;
  - a stream view with a `readable` of `Uint8Array` chunks and a `writable`,
    which the Sockets API needs.

  A channel is in one view once used. The stream view maps binary messages
  to chunks, and fails on text.

- **Any protocol.** A channel carries whatever messages its two ends agree
  on. Besides sockets, it serves application protocols between JavaScript
  and Rust: progress from a long Rust job, a subscription to host events
  during a request, or an interactive session.

### Request-scoped channels

The channel lives in the invocation's table and closes when the invocation
ends, after its `waitUntil` work and an open response body. Events arrive
while the invocation awaits them, through the host pump, so no new
scheduling is needed.

This covers a handler that connects to a database or an upstream
WebSocket, uses it and returns. It matches Workers, where I/O objects belong
to the request that created them and another request cannot use them. A
connection pool kept across requests, such as `pg.Pool` over `connect()`,
does not work in this scope. Pooling belongs in the host, behind a service
binding or a socket transport that keeps connections in Rust.

### Held connections

A server WebSocket outlives the Fetch handler's return. The handler returns
the upgrade response, and its invocation stays open while the connection
does:

- The instance is held, as by an open response body
  ([held instances](instance-pools.md#held-instances)). Its timers keep
  running, its listeners and closures stay in its heap, and host operations
  stay attributed to the invocation and its `Context`.
- Messages arrive through the host pump, as for a request-scoped channel.
- The invocation's deadline covers the handler until it returns the
  response. After that, two caller budgets replace it:
  `Limits::connection_idle_timeout`, since the last message in either
  direction, and `Limits::connection_lifetime`, since the upgrade. Exceeding
  either closes the connection with code 1001.
- The connection ends when either side closes it, a budget runs out, or
  the client goes away. JavaScript sees `close`. The invocation then ends
  as a response body does: reusable if nothing is left pending, retired
  otherwise.
- The pool's `max_held_connections` bounds the instances held this way. Its
  default is 0. The HTTP integration refuses an upgrade request with 503
  before JavaScript runs when the budget is spent, so connections never take
  the instances that requests need.

## Rust API

The core types live in `crates/fetchlet/src/host/channel/`:

- **`Message`** is `Text(String)` or `Binary(Bytes)`. **`CloseFrame`** has
  a `code` and a `reason`.
- **`ChannelEnd`** is Rust's side of a channel. It is an `async` sender and
  receiver of messages that ends in a close, and it implements `Stream` and
  `Sink` for transports that prefer them; `split()` separates the halves. Dropping it closes the channel
  with code 1006.
- **`ChannelService`** answers an open request from JavaScript. Its
  `ChannelRequest` carries the options, the invocation's trusted `Context`
  and the `ChannelEnd`, which the bridge pairs with JavaScript's end within
  the invocation's budgets; the service's future accepts or refuses the
  open.
- **`HostServices::channel(name, service)`** binds a service under a name in
  `env`. JavaScript opens it with `env.NAME.connect(options)`. Its name
  shares the binding namespace with `env` values and services.

Host code polled for a channel must not call the same application again;
the reentry guard of `fetch.poll` covers channel polling too.

Bridge operations are `channel.open`, `channel.send`, `channel.close`,
`channel.buffered` and, for the stream view, `channel.write` and
`channel.pause`. Opens, refusals, finished writes, messages and closes are
delivered with the completions of `fetch.poll`. They are bridge operations of the fetchlet
crate, not fetchlet-web operations, so `PROTOCOL_VERSION` is unaffected.

## APIs on channels

### `connect()`

The Sockets API of TC55 is `connect(address, options)`. It returns a
`Socket` with `readable`, `writable`, `opened`, `closed`, `close()` and
`startTls()`. postgres.js, pg and Redis clients use it on edge runtimes.

- **Guest.** `@fetchlet/web` implements `connect` over the stream view of a
  request-scoped channel and exports it from a subpath that `fetchlet`
  adapters expose. postgres.js's Workers build imports `cloudflare:sockets`.
  Aliasing that module is part of the
  [runtime key](../TODO.md#framework-runtime-needs-beyond-wintertc)
  decision, because it would come from choosing builds for `workerd`.
- **Host.** A `SocketService` opens TCP in Rust, performs TLS when
  `secureTransport` is `"on"` or after `startTls()`, and authorizes every
  address with a `SocketPolicy`. Like `FetchPolicy`, it starts as
  `deny_all()` and allows `host:port` pairs or ranges. Private and loopback
  addresses need an explicit allowance. A rewrite hook can redirect an
  address, as the fetch rewrite does. Without a socket service, `connect`
  rejects with `PermissionDenied`.
- **Limitation.** Credentials stay in JavaScript, because the database
  protocol carries them. The host cannot inject them as it injects fetch
  headers. Applications that must keep database credentials out of
  JavaScript use a service binding to a Rust data layer instead.

### Client `WebSocket`

A global `WebSocket` in `@fetchlet/web` follows the WHATWG WebSockets
standard over the message view of a request-scoped channel.

- `HostServices::websockets(WebSocketService)` sets the transport.
  `WebSocketService` takes a `FetchPolicy`, which applies to `ws:` and
  `wss:` as to `http:` and `https:`. It also takes the credentials hook,
  which adds headers to the opening handshake, as fetch requests get them.
- The handshake, framing, pings and the close handshake run in Rust.
  Extensions, such as permessage-deflate, are the transport's choice.
  `protocol` and `extensions` report what the server selected.
- Without a WebSocket service, the constructor succeeds and the socket
  errors and closes, as the standard does for a refused connection.

### Server upgrades

`fetchlet/runtime` exports `upgradeWebSocket(request)`. It returns the
socket and the response to return, the shape Deno uses. A held invocation
fits it, because the handler keeps the socket in its own scope:

```ts
import { upgradeWebSocket } from "fetchlet/runtime";

export default {
  fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const { socket, response } = upgradeWebSocket(request);
    let count = 0;
    socket.addEventListener("message", (event) => {
      count++;
      socket.send(`message #${count}: ${event.data}`);
    });
    return response;
  },
};
```

- `upgradeWebSocket` throws unless the request asked for a WebSocket
  upgrade and the host can hold the connection. `socket` is a `WebSocket`
  over the message view of a channel in the invocation's table. `response` is
  a 101 response that carries the channel's handle.
- Rust attaches the other `ChannelEnd` to the `http::Response` as a
  `ServerWebSocket` extension. fetchlet-http's axum and actix integrations complete
  the handshake and pump frames between the upgraded connection and the
  `ChannelEnd`. A handler that creates the socket but returns another
  response closes the channel when its invocation ends.
- `App::fetch` callers that are not HTTP servers read the extension
  themselves, so a Rust test or a Tauri command can talk to the socket
  directly.
- Framework helpers build on it: Hono's `upgradeWebSocket`, whose
  per-connection closures need exactly this held instance, and crossws
  through an adapter. Each comes with an example check when its adapter is
  written.

## Later work

- **Several connections per instance.** An instance serving N held
  connections runs their handlers interleaved. Attributing host operations,
  budgets and `Context` to each connection needs async context. Without it,
  every connection would share one scope and one deadline, and one
  connection's failure would close the rest. This waits until async context
  is available on every engine.
- **Host-held channels.** A channel that Rust owns beyond any invocation
  would deliver each message as a new invocation of an export, on whichever
  instance is idle, with per-channel ordering and state stored beside the
  channel. It suits Rust-initiated streams and survives instance rebuilds.
  Until a use needs more, Rust pushes to JavaScript with ordinary calls to
  an export, which work today.

## Not channels

- **The Cache API** stays deferred. When an adapter needs it, it will be a
  store that Rust configures, not a channel.
- **A generic host object with methods** is not part of this design. RPC to
  Rust already has service bindings over fetch, and a channel carries any
  message protocol an application defines.

## Alternatives considered

- **Instance-scoped channels delivered by separate invocations.** Events
  that arrive between invocations would wait in Rust, and the instance's
  owner would run an internal invocation to deliver them. With a pool, such
  a channel pins its instance anyway, because its listeners live in that
  heap. It would also lose timers between deliveries and need a new
  scheduling path. Holding the accepting invocation gets the same pinning
  with today's invocation rules.
- **Holding connections without a pool.** On one instance, an open
  WebSocket would stop every other request. Held connections need
  `max_held_connections` below the pool's `max`.
- **Workers' `WebSocketPair` and `accept()`.** fetchlet has no compatibility
  to keep with them. The Deno shape matches a held invocation directly.
- **A JavaScript event loop between invocations.** Letting timers and
  events run while no invocation is active breaks the invariant that every
  JavaScript execution has a deadline, an invocation scope and a budget.
- **Sockets inside the engine.** Giving the engines direct network access
  would bypass `FetchPolicy` and the transport configuration. It would also
  have to be repeated per engine.
- **Reserved JSON markers for resources in call values.** A key such as
  `"$handle"` collides with application data. Out-of-band paths do not.

## Verification

Each step lands with tests at its own boundary:

- **Handle table:**
  - a stale generation, a wrong kind and an identifier from an earlier
    invocation fail;
  - the end of an invocation releases its entries;
  - `open_channels` is enforced;
  - the handle operations are added to the bridge fuzz target.
- **Channels:**
  - message order and the close handshake;
  - both backpressure directions, measured by queue bytes;
  - `channel_message_bytes` and `channel_buffer_bytes`;
  - a request-scoped channel closes at the end of its invocation, after its
    `waitUntil` work;
  - cancellation under `CancelledCalls::Retire` and `Finish`;
  - the reentry guard;
  - a fuzz target that interleaves channel operations with invocation ends.
- **Held connections:**
  - a pool serves requests while a server WebSocket exchanges messages and
    timers;
  - the idle and lifetime budgets close the connection;
  - a client that leaves ends the invocation and keeps the instance;
  - `max_held_connections` refuses an upgrade before JavaScript runs.
- **APIs:**
  - the WPT `websockets` tests that do not need the WPT server's handlers;
  - a policy test that refuses private addresses;
  - postgres.js over `connect()` against a local PostgreSQL in a framework
    example;
  - an end-to-end check of a WebSocket route in an axum example.

## Order of work

1. The handle table, with body sources moved onto it. This changes no
   behavior, and the existing tests and fuzz targets cover it. Done, with
   channels on it too.
2. Request-scoped channels with `HostServices::channel`, both views and the
   new `Limits`. Done.
3. `connect()` with `SocketService` and `SocketPolicy`, with the transport
   in fetchlet-net behind a `sockets` feature. Done.
4. The client `WebSocket` with `WebSocketService`, with the transport in
   fetchlet-net behind a `websocket` feature. Done.
5. Held connections and `upgradeWebSocket` with server upgrades in the axum
   and actix integrations, after [instance pools](instance-pools.md). Done.
6. Resources in call arguments and results. Channels in arguments are
   done; results remain.

Steps 3 and 4 are independent of each other. Step 5 needs step 2 and pools.
Step 6 needs only step 1.

## Open questions

- Whether Hono's and crossws's helpers belong in fetchlet's adapters or
  upstream, as a fetchlet runtime target of their own.

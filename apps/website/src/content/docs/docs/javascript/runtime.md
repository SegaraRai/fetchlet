---
title: "Runtime and bindings"
slug: docs/javascript/runtime
description: "Access Rust host bindings, background tasks, TCP sockets, and WebSockets from server-side JavaScript."
---

`fetchlet/runtime` provides the Web API profile and host helpers available to
your server-side JavaScript.

## Bindings and background work

- `getBindings()` returns the read-only object of environment values, Rust
  functions, services, and channels configured on Rust's
  [`HostServices`](/docs/rust/host-services). Because bindings are fixed before
  modules evaluate, `getBindings()` works at top-level module scope as well as
  inside request handlers. Note that Rust bindings are **not** placed in
  `process.env`.
- `waitUntil(promise)` registers background work that can continue after a
  response is sent, within Rust's `background_timeout` and `background_tasks`
  limits.
- `createFetchHandler(fn)` from `fetchlet/runtime/adapter` wraps a standard
  `(request, context) => Response` handler for custom adapters:

```ts
import { createFetchHandler } from "fetchlet/runtime/adapter";

export const handle = createFetchHandler(async (request: Request, context: { name: string }) => {
  return new Response("Hello, " + context.name);
});

export function add(left: number, right: number) {
  return left + right;
}
```

## Binding types

Declare your Rust bindings once via module augmentation on `fetchlet/bindings`.
`getBindings()`, `ExportedHandler`, and every framework adapter's request
context pick up these types automatically:

```ts
import type { ChannelBinding, FunctionBinding, ServiceBinding } from "fetchlet/bindings";

declare module "fetchlet/bindings" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
    PROGRESS: ChannelBinding;
    DB: FunctionBinding<{
      query(sql: string, params: unknown[]): Promise<{ id: number }[]>;
      escape(text: string): string;
    }>;
  }
}
```

### Calling Rust functions

Methods on a `FunctionBinding` call Rust directly
([Function bindings](/docs/rust/host-services#function-bindings)). Async Rust
methods return a `Promise`; sync methods return immediately.

- Arguments and return values are serialized as JSON, except `ArrayBuffer` and
  views (`Uint8Array`, Node `Buffer`) which transfer directly as raw bytes
  without JSON encoding.
- Rust can also return channels (`HostChannel`) embedded in the result.
- Invalid argument types throw a `TypeError`; errors returned by the Rust method
  arrive as an `Error` with its `message` and `code`.

```ts
const rows = await env.DB.query("select id from users where name = ?", [name]);
const quoted = env.DB.escape(name);
const thumbnail: Uint8Array = await env.IMAGES.resize(await file.bytes(), 128);
```

### Opening channels

`env.PROGRESS.connect(options)` opens a bidirectional channel to a Rust
`ChannelService` ([Channels](/docs/rust/host-services#channels)). Choose one of
two views:

- `channel.socket()` — a `WebSocket`-like message interface
- `channel.stream()` — a `{ readable, writable }` pair of byte streams

`channel.opened` rejects if Rust refuses the connection, and `channel.closed`
resolves with the close code and reason. Channels close automatically when the
invocation ends.

```ts
const channel = env.PROGRESS.connect({ steps: 3, bytes: true });
return new Response(channel.stream().readable);
```

Rust can also lend `HostChannel` objects and byte arrays as arguments to
exported functions called with `App::call_with`
([Calls with bytes, channels and context](/docs/rust/host-services#calls-with-bytes-channels-and-context)):

```ts
import type { HostChannel } from "fetchlet/bindings";

export async function transcode(options: { format: string; progress: HostChannel }) {
  const progress = options.progress.socket();
  await options.progress.opened;
  progress.send("started");
}
```

## TCP sockets

`connect(address, options)` from `fetchlet/runtime` implements the WinterTC
Sockets API. Rust's [`SocketService`](/docs/rust/host-services#sockets)
authorizes the destination host and port; if no service is configured or the
policy refuses the address, `socket.opened` and `socket.closed` reject.

```ts
import { connect } from "fetchlet/runtime";

const socket = connect("db.example.com:5432", { secureTransport: "on" });
await socket.opened;
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode("PING"));
```

A socket belongs to the current invocation and closes when it ends (after any
`waitUntil` work and response body). Closing `writable` half-closes the write
side while keeping `readable` open. When the peer closes, `readable` ends, and
`writable` closes too unless `allowHalfOpen: true`.

For STARTTLS upgrades, connect with `secureTransport: "starttls"` and call
`startTls()` after the plain-text negotiation:

```ts
const plain = connect("mail.example.com:587", { secureTransport: "starttls" });
// ... plain-text STARTTLS negotiation ...
const secure = plain.startTls();
await secure.opened;
```

## Client WebSockets

The global `WebSocket` connects to external servers through Rust's
[`WebSocketService`](/docs/rust/host-services#client-websockets), which enforces
an origin policy and can attach handshake credentials that JavaScript never sees.

```ts
const socket = new WebSocket("wss://chat.example.com/room", ["chat.v2"]);
socket.addEventListener("open", () => socket.send("hello"));
socket.addEventListener("message", (event) => console.log(event.data));
```

A refused origin, failed handshake, or missing WebSocket service fires `error`
followed by `close` with code `1006`. `binaryType` supports `"blob"` and
`"arraybuffer"`. Sockets close automatically when the invocation ends.

## Server WebSockets

`upgradeWebSocket(request, { protocol })` from `fetchlet/runtime` accepts an
incoming WebSocket upgrade and returns `{ socket, response }`:

```ts
import { upgradeWebSocket } from "fetchlet/runtime";

export default {
  fetch(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const { socket, response } = upgradeWebSocket(request);
    let count = 0;
    socket.addEventListener("message", (event) => {
      count++;
      socket.send(`#${count}: ${event.data}`);
    });
    return response;
  },
};
```

- Rust handles the HTTP upgrade handshake, framing, and pings; `open` fires once
  the `101` response is sent.
- The connection holds its invocation and engine instance until it closes, so
  variables in the handler's closure belong to that connection.
- On the Rust side, enable `axum-websocket` or `actix-websocket` and set
  `Instances::max_held_connections` below `Instances::max`
  ([WebSocket upgrades](/docs/rust/fetchlet-http#websocket-upgrades)).
- Inside a framework app, import `upgradeWebSocket` from
  `fetchlet/runtime/handler` instead of `fetchlet/runtime` so the Web API
  profile is not installed twice. Hono apps can use `fetchlet/hono/websocket`,
  and Nitro apps can use `defineWebSocketHandler` with
  `experimental.websocket`.

## Subpaths

| Subpath                    | Purpose                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `fetchlet/runtime`         | Installs the Web API profile and exports runtime helpers (`connect`, `upgradeWebSocket`, etc.)                     |
| `fetchlet/runtime/adapter` | Installs the profile and exports `createFetchHandler`, `getBindings`, `waitUntil`, `upgradeWebSocket`, `upgradeResponse` |
| `fetchlet/runtime/handler` | Same exports as `fetchlet/runtime/adapter` without installing the profile (for use inside framework server code)   |
| `fetchlet/bindings`        | TypeScript types only (`ServiceBinding`, `ChannelBinding`, `FunctionBinding`, `FetchletBindings`, `HostChannel`)   |

## Runtime notes

- **Encoding:** UTF-8, UTF-16, and single-byte encodings are supported (plus
  `TextEncoderStream` / `TextDecoderStream`). Legacy multi-byte encodings
  (Shift_JIS, EUC-KR, etc.) are not included.
- **URLs:** Parsed in Rust via the WHATWG `url` crate (unless the `url` Cargo
  feature is disabled, in which case a JS fallback is used). Getters read cached
  components without crossing the Rust bridge.
- **Buffered bodies:** `Request` and `Response` bodies created from strings,
  `BufferSource`, or `URLSearchParams` stay as raw bytes until `.body` is
  accessed, avoiding stream overhead for common responses.

For the full list of supported APIs, see the
[Web API profile](/docs/compatibility/web-api).

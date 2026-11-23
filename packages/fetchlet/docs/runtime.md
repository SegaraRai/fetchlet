# fetchlet/runtime

The Web API profile and the Fetch entry that framework adapters build on.

`createFetchHandler` from `fetchlet/runtime/adapter` connects a function
over standard `Request` and `Response` to Rust's wire format. The second
argument is the per-call context. The same bundle can export plain
functions.

```ts
import { createFetchHandler } from "fetchlet/runtime/adapter";

export const handle = createFetchHandler(async (request: Request, context: { name: string }) => {
  return new Response("Hello, " + context.name);
});

export function add(left: number, right: number) {
  return left + right;
}
```

`getBindings()` returns the env values and services Rust fixed, and
`waitUntil(promise)` registers background work. The bindings are fixed
before the application's modules evaluate, so `getBindings()` also works at
module scope, like `import { env } from "cloudflare:workers"` on Workers.
`process.env` does not carry them. JavaScript `fetch` goes to
Rust's host services. [Web API profile](../../../docs/web-api.md) lists what
the profile provides.

## Binding types

`fetchlet/bindings` declares `ServiceBinding`, a service's `fetch`,
`ChannelBinding`, a channel service's `connect`, `FunctionBinding`, the
methods of Rust functions, and `FetchletBindings`, the
bindings Rust's `HostServices` define. An application declares its keys
once; `getBindings()`, `ExportedHandler` and each framework integration's
request context are typed with them:

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

`env.DB` calls Rust functions directly
([function bindings](../../../docs/host-services.md#function-bindings)).
A method Rust adds as async returns a Promise; a sync method returns its
result. Arguments cross as `JSON.stringify` encodes them, except that an
`ArrayBuffer` or view, such as a `Uint8Array`, crosses as its bytes;
results are JSON, with byte arrays Rust places in them as `Uint8Array`s
and channels as `HostChannel`s that belong to the invocation. Arguments
Rust cannot read as the method's types throw a `TypeError` naming the
method, and an error the method returns arrives as an `Error` with its
message and `code`:

```ts
const rows = await env.DB.query("select id from users where name = ?", [name]);
const quoted = env.DB.escape(name);
const thumbnail: Uint8Array = await env.IMAGES.resize(await file.bytes(), 128);
```

`env.PROGRESS.connect(options)` opens a channel of the Rust service, which
belongs to the current invocation. Take one view of it: `socket()`, a
WebSocket of its messages, or `stream()`, a `readable` and `writable` of
bytes. `opened` rejects when the service refuses, and `closed` settles with
the close code and reason ([host services](../../../docs/host-services.md#channels)):

```ts
const channel = env.PROGRESS.connect({ steps: 3, bytes: true });
return new Response(channel.stream().readable);
```

Rust can also lend channels to a function call with `Call`
([channels in calls](../../../docs/host-services.md#channels-in-calls)).
They arrive in the export's arguments as the same channel objects, typed
`HostChannel` from `fetchlet/bindings`, and close when the call ends:

```ts
import type { HostChannel } from "fetchlet/bindings";

export async function transcode(options: { format: string; progress: HostChannel }) {
  const progress = options.progress.socket();
  await options.progress.opened;
  progress.send("started");
}
```

## TCP sockets

`connect(address, options)` from `fetchlet/runtime` is the Sockets API's
`connect`. Rust's socket service authorizes the address and opens the
connection; without one, or for an address its policy refuses, the
socket's `opened` and `closed` reject
([host services](../../../docs/host-services.md#sockets)):

```ts
import { connect } from "fetchlet/runtime";

const socket = connect("db.example.com:5432", { secureTransport: "on" });
await socket.opened;
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode("PING"));
```

A socket belongs to the current invocation and closes when it ends, after
its `waitUntil` work and response body. Closing the writable sends the
end of the writes and keeps reading. When the peer's bytes end, the
readable ends, and so does the writable unless `allowHalfOpen: true`.

With `secureTransport: "starttls"`, the socket speaks plain TCP until
`startTls()`, which returns the TLS socket that carries the connection
from then on; the plain socket's streams end, and its writes still in
flight go out first:

```ts
const plain = connect("mail.example.com:587", { secureTransport: "starttls" });
// ... the plain-text exchange that asks the server to start TLS ...
const secure = plain.startTls();
await secure.opened;
```

## Client WebSockets

The global `WebSocket` connects to a server through Rust's WebSocket
service, which authorizes the URL's origin with the same kind of policy as
`fetch` and may add credentials to the handshake that JavaScript does not
see ([host services](../../../docs/host-services.md#client-websockets)):

```ts
const socket = new WebSocket("wss://chat.example.com/room", ["chat.v2"]);
socket.addEventListener("open", () => socket.send("hello"));
socket.addEventListener("message", (event) => console.log(event.data));
```

A socket belongs to the current invocation and closes when it ends, so an
invocation that waits for the conversation it needs, as a request handler
awaits a fetch, keeps it. A refused origin, a failed handshake and a host
without a WebSocket service fire `error` and then `close` with 1006.
`binaryType` chooses `Blob` or `ArrayBuffer` for binary messages.

## Server WebSockets

`upgradeWebSocket(request, { protocol })` from `fetchlet/runtime` accepts the
WebSocket upgrade a Fetch request asks for. It returns the socket and the
response to return from the handler, as Deno's does:

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

The socket follows the WebSocket interface: `open`, `message`, `error` and
`close` events, text and binary messages with `binaryType`,
`bufferedAmount`, and `close(code, reason)`. It opens once the host has sent
the 101. Rust performs the handshake, framing and pings. The handler's
invocation, and the instance with its timers and closures, stay held until
the connection closes, so state in the handler's scope belongs to one
connection.

`upgradeWebSocket` throws unless the request asks for a WebSocket and the
host holds connections: Rust sets `Instances::max_held_connections` and
serves the upgrade, as fetchlet-http's `websocket` and `actix-websocket`
features do for axum and actix-web
([WebSocket upgrades](../../../crates/fetchlet-http/README.md#websocket-upgrades)).
A socket the handler accepts but does not return closes when the invocation
ends. Outgoing connections use the global `WebSocket`
([client WebSockets](#client-websockets)).

In a framework app, import `upgradeWebSocket` from `fetchlet/runtime/handler`,
which does not install the profile: a framework build that bundles the
module then keeps a single profile, and the response still reaches the
profile's wire encoder. Hono apps use `upgradeWebSocket` from
`fetchlet/hono/websocket`, and Nitro apps `defineWebSocketHandler` with
`experimental.websocket`. `upgradeResponse(headers)` rebuilds the upgrade
response of the socket the invocation accepted, for integrations whose
framework copies the handler's response; the Qwik City middleware uses it.

## Subpaths

| Subpath                    | Contents                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fetchlet/runtime`         | The profile itself: installs the Web APIs, and exports the wire helpers                                                    |
| `fetchlet/runtime/adapter` | Installs the profile, then exports `createFetchHandler`, `getBindings`, `waitUntil`, `upgradeWebSocket`, `upgradeResponse` |
| `fetchlet/runtime/handler` | The same exports without installing the profile                                                                            |
| `fetchlet/bindings`        | Types only: `ServiceBinding`, `ChannelBinding`, `FunctionBinding` and `FetchletBindings`                                   |

Framework integrations whose builder initializes the profile first use the
side-effect-free `fetchlet/runtime/handler`. That keeps Node-only polyfills
out of intermediate SSR builds such as Astro's and selects the providers
once, in the final embedded build.

## Providers

Encoding uses `@exodus/bytes/encoding-lite.js`: UTF-8, UTF-16 and
single-byte encodings, plus `TextEncoderStream` and `TextDecoderStream`.
Legacy multi-byte encodings are not included. Environments with native
Encoding keep it.

Streams are web-streams-polyfill 4.5.1, pinned. Fetch's `bodyUsed` needs the
stream's internal disturbed state, which `web/stream-state.ts` reads from
this provider through a dedicated seam. Updating the provider means
rechecking that seam with the conformance and regression tests for direct
readers, cancellation, clone and tee.

URLs are parsed by the host's `url` crate (WHATWG URL Standard). The
constructor, `URL.parse`, `URL.canParse` and each setter make one `url.parse`
or `url.set` host call and keep every returned component, so getters do not
cross the bridge. `searchParams` is the profile's URLSearchParams, updated in
both directions as the standard requires. Host call input and output count
against `bridge_message_bytes`. Hosts without fetchlet's host functions, such as
Node, use core-js's URL, and environments with native URL keep it.
URLSearchParams is core-js everywhere.

Request and Response bodies created from a string, BufferSource or
URLSearchParams stay bytes until `body` is read. `arrayBuffer()`,
`bytes()`, `text()`, `json()`, `formData()` and `clone()` use those bytes
without a stream, and a fully read body's `body` returns a disturbed, locked
stream. Once `body` is read, the body is a Fetch byte stream. A Fetch entry
response that is still bytes goes to the wire without a stream.

`Blob.stream()` returns a byte stream where ArrayBuffer transfer is
available, which is every engine with fetchlet's backends.

[Conformance](../../../docs/conformance.md) lists the tests that cover the
profile and its known differences.

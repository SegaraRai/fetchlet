// Server WebSockets in a Fetch handler of the fetchlet App host.
// `upgradeWebSocket(request)` accepts the upgrade, in the shape Deno uses: it
// returns the socket and the response the handler returns. The socket
// follows the WebSocket interface of the WHATWG WebSockets standard
// (https://websockets.spec.whatwg.org/) over a host channel: Rust performs
// the handshake, framing and pings, and carries each message to and from
// the socket. The invocation, and with it the instance, stays open until the
// connection closes.

import { Snapshot } from "../async-context/async-context";
import { EventImpl, EventTargetImpl, defineEventHandler, dispatchTrusted } from "../dom/events";
import { encode } from "../encoding/bytes";
import { blobBytes } from "../file/blob";
import { MessageEventImpl } from "../html/message-channel";
import { reportTaskException } from "../html/timers";
import { runtime } from "../runtime/runtime";
import { dictionary, domString, unsignedShort, usvString } from "../webidl/idl";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const CREATE = Symbol("create");

/** The channel registry of the fetchlet App host's bridge. */
interface ChannelRegistry {
  upgrade(listener: {
    open(): void;
    message(data: string | Uint8Array): void;
    close(code: number, reason: string): void;
  }): number;
  send(id: number, data: string | Uint8Array): void;
  close(id: number, code: number, reason: string): void;
  buffered(id: number): number;
}

interface SocketState {
  channel: number;
  registry: ChannelRegistry;
  url: string;
  protocol: string;
  readyState: number;
  binaryType: "blob" | "arraybuffer";
  /** The context of the upgrade, in which the socket's listeners run. */
  snapshot: Snapshot;
}

const sockets = new WeakMap<object, SocketState>();

/** Upgrade responses by the channel each hands to the host. */
const upgrades = new WeakMap<object, number>();

function socket(value: unknown): SocketState {
  const found = sockets.get(value as object);
  if (!found) {
    throw new TypeError("Illegal invocation");
  }
  return found;
}

class CloseEventImpl extends EventImpl {
  #wasClean: boolean;
  #code: number;
  #reason: string;

  constructor(
    type: string,
    init?: {
      bubbles?: boolean;
      cancelable?: boolean;
      composed?: boolean;
      wasClean?: boolean;
      code?: number;
      reason?: string;
    },
  ) {
    if (arguments.length < 1) {
      throw new TypeError("CloseEvent requires a type");
    }
    const options = dictionary(init);
    super(type, options);
    this.#wasClean = Boolean(options.wasClean);
    this.#code = options.code === undefined ? 0 : unsignedShort(options.code);
    this.#reason = options.reason === undefined ? "" : usvString(options.reason);
  }

  get wasClean(): boolean {
    return this.#wasClean;
  }

  get code(): number {
    return this.#code;
  }

  get reason(): string {
    return this.#reason;
  }

  get [Symbol.toStringTag](): string {
    return "CloseEvent";
  }
}

function dispatch(target: WebSocketImpl, state: SocketState, event: EventImpl): void {
  try {
    state.snapshot.run(() => dispatchTrusted(target, event));
  } catch (error) {
    reportTaskException(error);
  }
}

/** The bytes of a message to send, or undefined for text. */
function binaryPayload(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  const blob = blobBytes(data);
  return blob === undefined ? undefined : blob.slice();
}

class WebSocketImpl extends EventTargetImpl {
  constructor(token?: symbol, state?: Omit<SocketState, "readyState" | "binaryType" | "snapshot">) {
    if (token !== CREATE || !state) {
      // Outgoing connections need a WebSocket transport in the host.
      throw new TypeError("WebSocket connections are not available in this host");
    }
    super();
    const entry: SocketState = {
      ...state,
      readyState: CONNECTING,
      binaryType: "blob",
      snapshot: new Snapshot(),
    };
    sockets.set(this, entry);
  }

  get url(): string {
    return socket(this).url;
  }

  get readyState(): number {
    return socket(this).readyState;
  }

  get bufferedAmount(): number {
    const state = socket(this);
    return state.readyState === OPEN || state.readyState === CLOSING
      ? state.registry.buffered(state.channel)
      : 0;
  }

  get extensions(): string {
    socket(this);
    return "";
  }

  get protocol(): string {
    return socket(this).protocol;
  }

  get binaryType(): "blob" | "arraybuffer" {
    return socket(this).binaryType;
  }

  set binaryType(value: unknown) {
    const state = socket(this);
    const type = domString(value);
    if (type === "blob" || type === "arraybuffer") {
      state.binaryType = type;
    }
  }

  send(data: unknown): void {
    const state = socket(this);
    if (arguments.length < 1) {
      throw new TypeError("send requires data");
    }
    if (state.readyState === CONNECTING) {
      throw new runtime.DOMException("The WebSocket is not open yet", "InvalidStateError");
    }
    // A message after the closing handshake started is dropped.
    if (state.readyState !== OPEN) {
      return;
    }
    const bytes = binaryPayload(data);
    state.registry.send(state.channel, bytes ?? usvString(data));
  }

  close(code?: unknown, reason?: unknown): void {
    const state = socket(this);
    let closeCode = 1000;
    if (code !== undefined) {
      closeCode = unsignedShort(code);
      if (closeCode !== 1000 && (closeCode < 3000 || closeCode > 4999)) {
        throw new runtime.DOMException("Invalid close code", "InvalidAccessError");
      }
    }
    const closeReason = reason === undefined ? "" : usvString(reason);
    if (encode(closeReason).byteLength > 123) {
      throw new runtime.DOMException("The close reason is too long", "SyntaxError");
    }
    if (state.readyState === CLOSING || state.readyState === CLOSED) {
      return;
    }
    state.readyState = CLOSING;
    state.registry.close(state.channel, closeCode, closeReason);
  }

  get [Symbol.toStringTag](): string {
    return "WebSocket";
  }
}

for (const [name, value] of Object.entries({
  CONNECTING,
  OPEN,
  CLOSING,
  CLOSED,
})) {
  for (const target of [WebSocketImpl, WebSocketImpl.prototype]) {
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
    });
  }
}
for (const type of ["open", "message", "error", "close"]) {
  defineEventHandler(WebSocketImpl.prototype, type);
}
for (const [constructor, name] of [
  [CloseEventImpl, "CloseEvent"],
  [WebSocketImpl, "WebSocket"],
] as const) {
  Object.defineProperty(constructor, "name", {
    value: name,
  });
}

runtime.CloseEvent ??= CloseEventImpl;

function asksForWebSocket(request: Request): boolean {
  const upgrade = request.headers.get("upgrade") ?? "";
  return upgrade.split(",").some((token) => token.trim().toLowerCase() === "websocket");
}

export interface UpgradeWebSocketOptions {
  /** The subprotocol the server selects, sent as `Sec-WebSocket-Protocol`. */
  protocol?: string;
}

/**
 * Accept the WebSocket upgrade a Fetch request asks for. Return `response`
 * from the handler; the socket opens once the host has sent it. Throws
 * unless the request asks for a WebSocket and the host can hold the
 * connection: Rust's `Instances::max_held_connections` bounds them, and
 * hosts other than the fetchlet App host have none.
 */
export function upgradeWebSocket(
  request: Request,
  options: UpgradeWebSocketOptions = {},
): {
  socket: WebSocket;
  response: Response;
} {
  if (!asksForWebSocket(request)) {
    throw new TypeError("The request does not ask for a WebSocket upgrade");
  }
  const registry = runtime.__fetchletChannels as ChannelRegistry | undefined;
  if (!registry) {
    throw new TypeError("This host does not hold WebSocket connections");
  }
  const protocol = options.protocol === undefined ? "" : domString(options.protocol);
  const url = new runtime.URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  // The listener runs once the socket exists.
  const opened: { target?: WebSocketImpl; state?: SocketState } = {};
  const channel = registry.upgrade({
    open() {
      const { target, state } = opened;
      if (target && state?.readyState === CONNECTING) {
        state.readyState = OPEN;
        dispatch(target, state, new EventImpl("open"));
      }
    },
    message(data) {
      const { target, state } = opened;
      if (!target || state?.readyState !== OPEN) {
        return;
      }
      let value: unknown = data;
      if (typeof data !== "string") {
        value =
          state.binaryType === "arraybuffer"
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : new runtime.Blob([data]);
      }
      dispatch(
        target,
        state,
        new MessageEventImpl("message", {
          data: value,
          origin: url.origin,
        }),
      );
    },
    close(code, reason) {
      const { target, state } = opened;
      if (!target || !state || state.readyState === CLOSED) {
        return;
      }
      state.readyState = CLOSED;
      // 1006: the connection ended without a closing handshake.
      const wasClean = code !== 1006;
      if (!wasClean) {
        dispatch(target, state, new EventImpl("error"));
      }
      dispatch(
        target,
        state,
        new CloseEventImpl("close", {
          wasClean,
          code,
          reason,
        }),
      );
    },
  });
  const target = new WebSocketImpl(CREATE, {
    channel,
    registry,
    url: url.href,
    protocol,
  });
  opened.target = target;
  opened.state = socket(target);

  const headers = new runtime.Headers();
  if (protocol !== "") {
    headers.set("sec-websocket-protocol", protocol);
  }
  const response = new runtime.Response(null, {
    status: 200,
    headers,
  });
  // A 101 cannot be constructed; the host completes the handshake for it.
  Object.defineProperty(response, "status", {
    value: 101,
    configurable: true,
    writable: true,
  });
  upgrades.set(response, channel);
  return {
    socket: target as unknown as WebSocket,
    response,
  };
}

/** The channel of an upgrade response from upgradeWebSocket, if it is one. */
export function upgradeOf(response: Response): number | undefined {
  return upgrades.get(response);
}

export { CloseEventImpl, WebSocketImpl };

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

/** What a channel of the fetchlet App host's bridge delivers. */
export interface ChannelListener {
  open(): void;
  message(data: string | Uint8Array<ArrayBuffer>): void;
  close(code: number, reason: string): void;
  refused?(message: string): void;
  /** A socket's peer ended its bytes; the socket still writes. */
  end?(): void;
  /** A socket's connection switched to TLS, answering `startTls`. */
  secure?(): void;
}

/** The channel registry of the fetchlet App host's bridge. */
export interface ChannelRegistry {
  upgrade(listener: ChannelListener): number;
  accepted(): number | undefined;
  open(service: string, options: unknown, listener: ChannelListener): number;
  connect(
    address: {
      hostname: string;
      port: number;
      secureTransport: "off" | "on" | "starttls";
    },
    listener: ChannelListener,
  ): number;
  endWrites(id: number): void;
  startTls(id: number): void;
  send(id: number, data: string | Uint8Array): void;
  write(id: number, data: Uint8Array): Promise<void>;
  pause(id: number, paused: boolean): void;
  close(id: number, code: number, reason: string): void;
  buffered(id: number): number;
}

/** The bridge's channel registry, when the host has one. */
export function channelRegistry(): ChannelRegistry | undefined {
  return runtime.__fetchletChannels as ChannelRegistry | undefined;
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

/**
 * The channel an upgrade response hands to the host. A registered symbol, so
 * that the wire encoder finds it when a framework build bundles another copy
 * of this module. A forged value names no upgrade the host accepted.
 */
const UPGRADE = Symbol.for("fetchlet.websocket.upgrade");

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

  override get [Symbol.toStringTag](): string {
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

  override get [Symbol.toStringTag](): string {
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
  /**
   * Other headers of the 101 response, such as cookies. A
   * `Sec-WebSocket-Protocol` among them selects the subprotocol when
   * `protocol` does not.
   */
  headers?: HeadersInit;
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
  const registry = channelRegistry();
  if (!registry) {
    throw new TypeError("This host does not hold WebSocket connections");
  }
  const headers = new runtime.Headers(options.headers);
  const protocol =
    options.protocol === undefined
      ? (headers.get("sec-websocket-protocol") ?? "")
      : domString(options.protocol);
  const url = new runtime.URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const { socket: target, channel } = openSocket(
    (listener) => registry.upgrade(listener),
    registry,
    url.href,
    protocol,
    url.origin,
  );

  headers.delete("sec-websocket-protocol");
  if (protocol !== "") {
    headers.set("sec-websocket-protocol", protocol);
  }
  return {
    socket: target as unknown as WebSocket,
    response: switchingProtocols(channel, headers),
  };
}

/**
 * A WebSocket over the channel `connect` opens with the listener it is
 * given. The socket is CONNECTING until the channel opens.
 */
export function openSocket(
  connect: (listener: ChannelListener) => number,
  registry: ChannelRegistry,
  url: string,
  protocol: string,
  origin: string,
): {
  socket: WebSocketImpl;
  channel: number;
} {
  // The listener runs once the socket exists.
  const opened: {
    target?: WebSocketImpl;
    state?: SocketState;
  } = {};
  const ended = (code: number, reason: string): void => {
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
  };
  const channel = connect({
    open(): void {
      const { target, state } = opened;
      if (target && state?.readyState === CONNECTING) {
        state.readyState = OPEN;
        dispatch(target, state, new EventImpl("open"));
      }
    },
    message(data): void {
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
          origin,
        }),
      );
    },
    close: ended,
    refused(): void {
      // A refused connection fails as one the network refused.
      ended(1006, "");
    },
  });
  const target = new WebSocketImpl(CREATE, {
    channel,
    registry,
    url,
    protocol,
  });
  opened.target = target;
  opened.state = socket(target);
  return {
    socket: target,
    channel,
  };
}

/** The 101 response that hands `channel` to the host. */
function switchingProtocols(channel: number, headers: Headers): Response {
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
  Object.defineProperty(response, UPGRADE, {
    value: channel,
  });
  return response;
}

/**
 * The upgrade response of the WebSocket the current invocation accepted, with
 * `headers`. For framework integrations whose framework copies the handler's
 * response into one of its own, which cannot be constructed with status 101.
 */
export function upgradeResponse(headers?: HeadersInit): Response {
  const channel = channelRegistry()?.accepted();
  if (channel === undefined) {
    throw new TypeError("No WebSocket upgrade was accepted");
  }
  return switchingProtocols(channel, new runtime.Headers(headers));
}

/** The channel of an upgrade response from upgradeWebSocket, if it is one. */
export function upgradeOf(response: Response): number | undefined {
  const channel = (response as unknown as Record<symbol, unknown>)[UPGRADE];
  return typeof channel === "number" ? channel : undefined;
}

export { CloseEventImpl, WebSocketImpl };

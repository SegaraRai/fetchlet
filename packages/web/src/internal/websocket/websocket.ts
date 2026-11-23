// The WebSocket interface of the WHATWG WebSockets standard
// (https://websockets.spec.whatwg.org/) over a channel of the fetchlet App
// host. Rust performs the handshake, framing, pings and the closing
// handshake, and carries each message to and from the socket. The same
// socket serves a client connection, which `new WebSocket(url, protocols)`
// opens through the host's WebSocket service, an upgrade the Fetch handler
// accepts (./upgrade.ts), and the message view of an env binding's channel.

import { Snapshot } from "../async-context/async-context";
import { channelRegistry, type ChannelListener, type ChannelRegistry } from "../channels/registry";
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

interface SocketState {
  channel: number;
  /** Absent when the host has no channels: the socket only fails. */
  registry: ChannelRegistry | undefined;
  url: string;
  protocol: string;
  extensions: string;
  /** The origin of message events. */
  origin: string;
  readyState: number;
  binaryType: "blob" | "arraybuffer";
  /** The context of the upgrade, in which the socket's listeners run. */
  snapshot: Snapshot;
}

const sockets = new WeakMap<object, SocketState>();

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

type SocketInit = Pick<SocketState, "registry" | "url" | "protocol" | "origin">;

class WebSocketImpl extends EventTargetImpl {
  /**
   * `new WebSocket(url, protocols)` opens a client connection through the
   * host's WebSocket service. The host's views construct sockets with an
   * internal token instead.
   */
  constructor(url?: unknown, protocols?: unknown) {
    if (url === CREATE) {
      super();
      const init = protocols as SocketInit;
      sockets.set(this, newState(init));
      return;
    }
    if (arguments.length < 1) {
      throw new TypeError("WebSocket requires a URL");
    }
    const target = clientUrl(url);
    const requested = clientProtocols(protocols);
    super();
    const registry = channelRegistry();
    const state = newState({
      registry,
      url: target.href,
      protocol: "",
      origin: target.origin,
    });
    sockets.set(this, state);
    try {
      if (!registry) {
        throw new TypeError("This host has no WebSocket connections");
      }
      state.channel = registry.websocket(
        { url: target.href, protocols: requested },
        socketListener(this, state),
      );
    } catch {
      // The host refused at once: the connection fails as one the network
      // refused, after the constructor returns.
      state.registry = undefined;
      runtime.setTimeout(() => ended(this, state, 1006, ""), 0);
    }
  }

  get url(): string {
    return socket(this).url;
  }

  get readyState(): number {
    return socket(this).readyState;
  }

  get bufferedAmount(): number {
    const state = socket(this);
    return state.registry && (state.readyState === OPEN || state.readyState === CLOSING)
      ? state.registry.buffered(state.channel)
      : 0;
  }

  get extensions(): string {
    return socket(this).extensions;
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
    state.registry?.send(state.channel, bytes ?? usvString(data));
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
    // Closing while connecting fails the connection: the host abandons the
    // handshake and the socket closes with 1006.
    state.registry?.close(state.channel, closeCode, closeReason);
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

if (channelRegistry()) {
  runtime.WebSocket ??= WebSocketImpl;
}

function newState(init: SocketInit): SocketState {
  return {
    ...init,
    channel: 0,
    extensions: "",
    readyState: CONNECTING,
    binaryType: "blob",
    snapshot: new Snapshot(),
  };
}

/** A client URL: absolute, ws or wss (http and https map to them), no fragment. */
function clientUrl(value: unknown): URL {
  let url: URL;
  try {
    url = new runtime.URL(usvString(value));
  } catch {
    throw new runtime.DOMException("Invalid WebSocket URL", "SyntaxError");
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new runtime.DOMException("A WebSocket URL is ws: or wss:", "SyntaxError");
  }
  if (url.hash !== "" || url.href.endsWith("#")) {
    throw new runtime.DOMException("A WebSocket URL has no fragment", "SyntaxError");
  }
  return url;
}

// RFC 9110 token characters, which a subprotocol name consists of.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The subprotocols to request: tokens, each once. */
function clientProtocols(value: unknown): string[] {
  let protocols: string[];
  if (value === undefined) {
    protocols = [];
  } else if (typeof value === "object" && value !== null && Symbol.iterator in value) {
    protocols = Array.from(value as Iterable<unknown>, domString);
  } else {
    protocols = [domString(value)];
  }
  const seen = new Set<string>();
  for (const protocol of protocols) {
    if (!TOKEN.test(protocol) || seen.has(protocol)) {
      throw new runtime.DOMException("Invalid WebSocket subprotocol", "SyntaxError");
    }
    seen.add(protocol);
  }
  return protocols;
}

/** The socket's end: error first unless clean, then close. */
function ended(target: WebSocketImpl, state: SocketState, code: number, reason: string): void {
  if (state.readyState === CLOSED) {
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
}

/** The listener that drives `target` from its channel's arrivals. */
function socketListener(target: WebSocketImpl, state: SocketState): ChannelListener {
  return {
    open(accepted): void {
      if (state.readyState !== CONNECTING) {
        return;
      }
      if (accepted) {
        state.protocol = accepted.protocol;
        state.extensions = accepted.extensions;
      }
      state.readyState = OPEN;
      dispatch(target, state, new EventImpl("open"));
    },
    message(data): void {
      if (state.readyState !== OPEN) {
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
          origin: state.origin,
        }),
      );
    },
    close(code, reason): void {
      ended(target, state, code, reason);
    },
    refused(): void {
      // A refused connection fails as one the network refused.
      ended(target, state, 1006, "");
    },
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
  const target = new WebSocketImpl(CREATE, {
    registry,
    url,
    protocol,
    origin,
  } satisfies SocketInit);
  const state = socket(target);
  state.channel = connect(socketListener(target, state));
  return {
    socket: target,
    channel: state.channel,
  };
}

export { CloseEventImpl, WebSocketImpl };

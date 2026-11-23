// TCP sockets in the fetchlet App host: `connect(address, options)` of the
// Sockets API (https://sockets-api.proposal.wintertc.org/). Rust opens each
// connection through the socket service the host configured, whose policy
// authorizes the address, and carries its bytes over a channel of the
// current invocation; the socket closes when the invocation ends.

import { streamView } from "../websocket/channel";
import { channelRegistry, type ChannelListener } from "../websocket/websocket";

const CREATE = Symbol("create");

/** A host name or IP literal and a port. */
export interface SocketAddress {
  hostname: string;
  port: number;
}

export interface SocketOptions {
  /** `"on"` speaks TLS from the start; `"starttls"` is not supported yet. */
  secureTransport?: "off" | "on" | "starttls";
  /** Half-open sockets are not supported; only `false` is accepted. */
  allowHalfOpen?: boolean;
}

/** What `opened` reports; the host does not disclose addresses. */
export interface SocketInfo {
  remoteAddress?: string;
  localAddress?: string;
}

/** A TCP connection, as the Sockets API's `Socket`. */
export interface Socket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<BufferSource>;
  readonly opened: Promise<SocketInfo>;
  readonly closed: Promise<void>;
  readonly upgraded: boolean;
  readonly secureTransport: "off" | "on" | "starttls";
  close(): Promise<void>;
  startTls(): Socket;
}

function settled<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A socket nobody awaits must not report an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Split `host:port`, with brackets around an IPv6 host. */
function parseAddress(address: unknown): SocketAddress {
  if (typeof address === "string") {
    const separator = address.lastIndexOf(":");
    if (separator <= 0) {
      throw new TypeError("A socket address needs a host and a port");
    }
    const host = address.slice(0, separator);
    return {
      hostname: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host,
      port: Number(address.slice(separator + 1)),
    };
  }
  if (typeof address === "object" && address !== null) {
    const { hostname, port } = address as Partial<SocketAddress>;
    return { hostname: String(hostname ?? ""), port: Number(port) };
  }
  throw new TypeError("A socket address is a string or a { hostname, port } object");
}

class SocketImpl implements Socket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<BufferSource>;
  readonly secureTransport: "off" | "on";
  #opened = settled<SocketInfo>();
  #closed = settled<void>();
  #close: () => void;

  constructor(token: symbol, address: SocketAddress, secureTransport: "off" | "on") {
    if (token !== CREATE) {
      throw new TypeError("Illegal constructor");
    }
    this.secureTransport = secureTransport;
    const opened = this.#opened;
    const closed = this.#closed;
    const registry = channelRegistry();
    // The stream view's listener, once the channel exists.
    const views: { stream?: ChannelListener } = {};
    const listener: ChannelListener = {
      open() {
        opened.resolve({});
        views.stream?.open();
      },
      message(data) {
        views.stream?.message(data);
      },
      close(code, reason) {
        const error = new TypeError(reason || `The socket closed with code ${code}`);
        opened.reject(error);
        if (code === 1006 || code === 1011) {
          closed.reject(error);
        } else {
          closed.resolve();
        }
        views.stream?.close(code, reason);
      },
      refused(message) {
        const error = new TypeError(message);
        opened.reject(error);
        closed.reject(error);
        views.stream?.refused?.(message);
      },
    };
    let id: number;
    try {
      if (!registry) {
        throw new TypeError("This host has no sockets");
      }
      id = registry.connect({ ...address, secureTransport }, listener);
    } catch (error) {
      // The host refused at once: the socket fails as a refused connection.
      const reason = error instanceof Error ? error.message : String(error);
      const failed = new TypeError(reason);
      this.readable = new ReadableStream({
        start(controller) {
          controller.error(failed);
        },
      });
      this.writable = new WritableStream({
        start(controller) {
          controller.error(failed);
        },
      });
      opened.reject(failed);
      closed.reject(failed);
      this.#close = () => {};
      return;
    }
    const stream = streamView(registry, id, opened.promise);
    views.stream = stream.listener;
    this.readable = stream.readable;
    this.writable = stream.writable;
    this.#close = () => registry.close(id, 1000, "");
  }

  get opened(): Promise<SocketInfo> {
    return this.#opened.promise;
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  get upgraded(): boolean {
    return false;
  }

  close(): Promise<void> {
    this.#close();
    return this.#closed.promise;
  }

  startTls(): Socket {
    throw new TypeError(
      "startTls needs secureTransport 'starttls', which this host does not support yet",
    );
  }

  get [Symbol.toStringTag](): string {
    return "Socket";
  }
}

/**
 * Open a TCP connection, as the Sockets API's `connect`. Rust's socket
 * service authorizes the address and opens the connection; without one, or
 * for an address its policy refuses, `opened` and `closed` reject. The
 * socket belongs to the current invocation and closes when it ends.
 */
export function connect(address: string | SocketAddress, options: SocketOptions = {}): Socket {
  const parsed = parseAddress(address);
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new TypeError("A socket port is an integer from 1 to 65535");
  }
  const secureTransport = options.secureTransport ?? "off";
  if (secureTransport === "starttls") {
    throw new TypeError("secureTransport 'starttls' is not supported yet");
  }
  if (secureTransport !== "off" && secureTransport !== "on") {
    throw new TypeError("secureTransport is 'off', 'on' or 'starttls'");
  }
  if (options.allowHalfOpen === true) {
    throw new TypeError("Half-open sockets are not supported");
  }
  return new SocketImpl(CREATE, parsed, secureTransport);
}

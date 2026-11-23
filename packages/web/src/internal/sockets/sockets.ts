// TCP sockets in the fetchlet App host: `connect(address, options)` of the
// Sockets API (https://sockets-api.proposal.wintertc.org/). Rust opens each
// connection through the socket service the host configured, whose policy
// authorizes the address, and carries its bytes over a channel of the
// current invocation; the socket closes when the invocation ends.

import { bufferSourceBytes } from "../channels/bytes";
import { deferred } from "../channels/deferred";
import { channelRegistry, type ChannelListener, type ChannelRegistry } from "../channels/registry";
import { runtime } from "../runtime/runtime";

const CREATE = Symbol("create");

/** A host name or IP literal and a port. */
export interface SocketAddress {
  hostname: string;
  port: number;
}

export interface SocketOptions {
  /**
   * `"on"` speaks TLS from the start; `"starttls"` speaks plain TCP until
   * `startTls()`.
   */
  secureTransport?: "off" | "on" | "starttls";
  /**
   * Keep the writable open after the peer's bytes end. By default, the end
   * of the readable closes the writable too.
   */
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

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Arrival =
  | { kind: "open" }
  | { kind: "message"; data: string | Uint8Array }
  | { kind: "end" }
  | { kind: "close"; code: number; reason: string }
  | { kind: "refused"; message: string };

/**
 * One connection's channel. Its arrivals go to the socket that currently
 * owns the connection: the one `connect` returned, then the one
 * `startTls()` returned.
 */
class Connection {
  readonly registry: ChannelRegistry;
  id = 0;
  owner!: SocketImpl;

  constructor(registry: ChannelRegistry) {
    this.registry = registry;
  }

  listener(): ChannelListener {
    return {
      open: () => this.owner.arrive({ kind: "open" }),
      secure: () => this.owner.arrive({ kind: "open" }),
      message: (data) => this.owner.arrive({ kind: "message", data }),
      end: () => this.owner.arrive({ kind: "end" }),
      close: (code, reason) => this.owner.arrive({ kind: "close", code, reason }),
      refused: (message) => this.owner.arrive({ kind: "refused", message }),
    };
  }
}

class SocketImpl implements Socket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<BufferSource>;
  readonly secureTransport: "off" | "on" | "starttls";
  #connection: Connection | undefined;
  #allowHalfOpen: boolean;
  #opened = deferred<SocketInfo>();
  #closed = deferred<void>();
  #isOpen = false;
  #isClosed = false;
  #upgraded = false;
  #closing = false;
  #reader!: ReadableStreamDefaultController<Uint8Array>;
  #writer!: WritableStreamDefaultController;
  /** The readable ended or was cancelled; arrivals are dropped. */
  #readDone = false;
  #paused = false;
  /** Rust has the end of this socket's writes, or the socket handed over. */
  #writesDone = false;
  /** The write in flight, which a half close or upgrade waits for. */
  #writing: Promise<void> = Promise.resolve();

  constructor(token: symbol, secureTransport: "off" | "on" | "starttls", allowHalfOpen: boolean) {
    if (token !== CREATE) {
      throw new TypeError("Illegal constructor");
    }
    this.secureTransport = secureTransport;
    this.#allowHalfOpen = allowHalfOpen;
    this.readable = new runtime.ReadableStream({
      start: (controller: ReadableStreamDefaultController<Uint8Array>) => {
        this.#reader = controller;
      },
      pull: () => {
        // The reader has room again: Rust delivers what it held back.
        this.#pause(false);
      },
      cancel: () => {
        this.#readDone = true;
        this.#pause(false);
        if (!this.#allowHalfOpen) {
          this.#endWrites();
        }
      },
    });
    this.writable = new runtime.WritableStream({
      start: (controller: WritableStreamDefaultController) => {
        this.#writer = controller;
      },
      write: (chunk: unknown) => {
        const bytes = bufferSourceBytes(chunk);
        if (this.#writesDone) {
          return Promise.reject(new TypeError("The socket's writable is closed"));
        }
        // Tracked from the start, so a half close or startTls that follows
        // waits for this write's bytes.
        this.#writing = this.#opened.promise.then(() => {
          const connection = this.#connection;
          if (!connection || this.#isClosed) {
            throw new TypeError("The socket closed");
          }
          return connection.registry.write(connection.id, bytes);
        });
        return this.#writing;
      },
      close: async () => {
        await this.#opened.promise;
        this.#endWrites();
      },
      abort: () => {
        void this.close();
      },
    });
  }

  /** Take over a connection's arrivals. */
  own(connection: Connection): void {
    this.#connection = connection;
    connection.owner = this;
  }

  /** Fail the socket before or instead of any connection. */
  fail(message: string): void {
    const error = new TypeError(message);
    this.#isClosed = true;
    if (!this.#readDone) {
      this.#readDone = true;
      this.#reader.error(error);
    }
    if (!this.#writesDone) {
      this.#writesDone = true;
      this.#writer.error(error);
    }
    this.#opened.reject(error);
    this.#closed.reject(error);
  }

  arrive(arrival: Arrival): void {
    switch (arrival.kind) {
      case "open":
        this.#isOpen = true;
        this.#opened.resolve({});
        break;

      case "message":
        this.#message(arrival.data);
        break;

      case "end":
        // The peer's bytes ended. Without half-open, the writable closes
        // too, after the write in flight.
        this.#finishReading();
        if (!this.#allowHalfOpen) {
          this.#endWrites();
        }
        break;

      case "close":
        this.#close(arrival.code, arrival.reason);
        break;

      case "refused":
        this.fail(arrival.message);
        break;
    }
  }

  #message(data: string | Uint8Array): void {
    if (this.#readDone) {
      return;
    }
    if (typeof data === "string") {
      // Sockets carry bytes only; a text message is a host error.
      this.#readDone = true;
      this.#reader.error(new TypeError("A text message arrived on a socket"));
      return;
    }
    this.#reader.enqueue(data);
    // The reader is full: Rust holds further bytes, and the peer waits.
    if ((this.#reader.desiredSize ?? 0) <= 0) {
      this.#pause(true);
    }
  }

  #pause(paused: boolean): void {
    const connection = this.#connection;
    if (this.#paused !== paused && connection && connection.owner === this && !this.#isClosed) {
      this.#paused = paused;
      connection.registry.pause(connection.id, paused);
    }
  }

  #finishReading(): void {
    if (!this.#readDone) {
      this.#readDone = true;
      this.#reader.close();
    }
  }

  /** Send Rust the end of this socket's writes, after the write in flight. */
  #endWrites(): void {
    if (this.#writesDone || !this.#isOpen) {
      return;
    }
    this.#writesDone = true;
    const connection = this.#connection;
    void this.#writing
      .catch(() => {})
      .then(() => {
        if (connection && connection.owner === this && !this.#isClosed) {
          connection.registry.endWrites(connection.id);
        }
      });
  }

  #close(code: number, reason: string): void {
    this.#isClosed = true;
    // 1006: no close arrived; 1011: the connection failed. A close this
    // socket asked for settles `closed` either way.
    const failed = (code === 1006 || code === 1011) && !this.#closing;
    const error = new TypeError(reason || `The socket closed with code ${code}`);
    if (!this.#readDone) {
      this.#readDone = true;
      if (failed) {
        this.#reader.error(error);
      } else {
        this.#reader.close();
      }
    }
    if (!this.#writesDone) {
      this.#writesDone = true;
      this.#writer.error(error);
    }
    this.#opened.reject(error);
    if (failed) {
      this.#closed.reject(error);
    } else {
      this.#closed.resolve();
    }
  }

  get opened(): Promise<SocketInfo> {
    return this.#opened.promise;
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  get upgraded(): boolean {
    return this.#upgraded;
  }

  close(): Promise<void> {
    const connection = this.#connection;
    if (!this.#isClosed && !this.#closing && connection && connection.owner === this) {
      this.#closing = true;
      connection.registry.close(connection.id, 1000, "");
    }
    return this.#closed.promise;
  }

  startTls(): Socket {
    if (this.secureTransport !== "starttls") {
      throw new TypeError("startTls needs a socket connected with secureTransport 'starttls'");
    }
    if (this.#upgraded) {
      throw new TypeError("The socket is already upgraded");
    }
    const connection = this.#connection;
    if (!connection || this.#isClosed || this.#closing || this.#writesDone || this.#readDone) {
      throw new TypeError("The socket is closed");
    }
    this.#upgraded = true;
    const secure = new SocketImpl(CREATE, "on", this.#allowHalfOpen);
    // From here the plain socket is done: its streams end, and the bytes
    // that follow belong to the secure socket.
    this.#writesDone = true;
    this.#finishReading();
    this.#pause(false);
    const writing = this.#writing;
    void this.#opened.promise
      .then(() => writing.catch(() => {}))
      .then(
        () => {
          if (this.#isClosed) {
            secure.fail("The socket closed before TLS started");
            return;
          }
          secure.own(connection);
          this.#isClosed = true;
          this.#writer.error(new TypeError("The socket was upgraded to TLS"));
          this.#closed.resolve();
          try {
            connection.registry.startTls(connection.id);
          } catch (error) {
            secure.fail(errorMessage(error));
            connection.registry.close(connection.id, 1000, "");
          }
        },
        (error: unknown) => secure.fail(errorMessage(error)),
      );
    return secure;
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
  if (secureTransport !== "off" && secureTransport !== "on" && secureTransport !== "starttls") {
    throw new TypeError("secureTransport is 'off', 'on' or 'starttls'");
  }
  const socket = new SocketImpl(CREATE, secureTransport, Boolean(options.allowHalfOpen));
  const registry = channelRegistry();
  if (!registry) {
    socket.fail("This host has no sockets");
    return socket;
  }
  const connection = new Connection(registry);
  socket.own(connection);
  try {
    connection.id = registry.connect(
      {
        ...parsed,
        secureTransport,
      },
      connection.listener(),
    );
  } catch (error) {
    // The host refused at once: the socket fails as a refused connection.
    socket.fail(errorMessage(error));
  }
  return socket;
}

// Channels of env bindings in the fetchlet App host. `env.NAME.connect(options)`
// asks the Rust ChannelService bound as NAME to open a channel, which
// belongs to the current invocation and closes when it ends. The channel
// offers two views, of which it takes one: a WebSocket of its messages, or
// a byte stream of its binary messages.

import { runtime } from "../runtime/runtime";
import { channelRegistry, openSocket } from "./websocket";
import type { ChannelListener, ChannelRegistry } from "./websocket";

const CREATE = Symbol("create");

/** How a channel ended, in WebSocket's close code space. */
export interface ChannelClose {
  code: number;
  reason: string;
}

/** The byte stream view of a channel. */
export interface ChannelStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<BufferSource>;
}

/** A channel that a Rust ChannelService opened for this invocation. */
export interface HostChannel {
  /** Settles when the service accepts the open, or rejects if it refuses. */
  readonly opened: Promise<void>;
  /** Settles when the channel ends; 1006 is an end without a close. */
  readonly closed: Promise<ChannelClose>;
  /** The channel as a WebSocket of text and binary messages. */
  socket(): WebSocket;
  /** The channel as a stream of the bytes of its binary messages. */
  stream(): ChannelStream;
  close(code?: number, reason?: string): void;
}

/** An env binding whose `connect` opens channels. */
export interface ChannelBinding {
  connect(options?: unknown): HostChannel;
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
  // A channel nobody awaits must not report an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function bufferSourceBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk.slice(0));
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    );
  }
  throw new TypeError("A channel stream writes ArrayBuffer or ArrayBufferView chunks");
}

class HostChannelImpl implements HostChannel {
  #registry: ChannelRegistry;
  #id: number;
  #service: string;
  #opened = settled<void>();
  #closed = settled<ChannelClose>();
  /** The view's listener, once a view is taken. */
  #view: ChannelListener | undefined;
  /** Arrivals before a view is taken, replayed to it. */
  #early: ((listener: ChannelListener) => void)[] = [];

  constructor(token: symbol, registry: ChannelRegistry, service: string, options: unknown) {
    if (token !== CREATE) {
      throw new TypeError("Illegal constructor");
    }
    this.#registry = registry;
    this.#service = service;
    this.#id = registry.open(service, options, {
      open: () => {
        this.#opened.resolve();
        this.#deliver((view) => view.open());
      },
      message: (data) => this.#deliver((view) => view.message(data)),
      close: (code, reason) => {
        this.#opened.reject(new TypeError("The channel closed before it opened"));
        this.#closed.resolve({ code, reason });
        this.#deliver((view) => view.close(code, reason));
      },
      refused: (message) => {
        this.#opened.reject(new TypeError(message));
        this.#closed.resolve({ code: 1006, reason: "" });
        this.#deliver((view) => view.refused?.(message));
      },
    });
  }

  #deliver(event: (listener: ChannelListener) => void): void {
    if (this.#view) {
      event(this.#view);
    } else {
      this.#early.push(event);
    }
  }

  #take(view: ChannelListener): void {
    if (this.#view) {
      throw new TypeError("The channel's view is already taken");
    }
    this.#view = view;
    for (const event of this.#early.splice(0)) {
      event(view);
    }
  }

  get opened(): Promise<void> {
    return this.#opened.promise;
  }

  get closed(): Promise<ChannelClose> {
    return this.#closed.promise;
  }

  socket(): WebSocket {
    if (this.#view) {
      throw new TypeError("The channel's view is already taken");
    }
    let listener!: ChannelListener;
    const { socket } = openSocket(
      (view) => {
        listener = view;
        return this.#id;
      },
      this.#registry,
      "",
      "",
      "",
    );
    this.#take(listener);
    return socket as unknown as WebSocket;
  }

  stream(): ChannelStream {
    if (this.#view) {
      throw new TypeError("The channel's view is already taken");
    }
    const registry = this.#registry;
    const id = this.#id;
    const opened = this.#opened.promise;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let paused = false;
    let ended = false;
    const fail = (error: unknown) => {
      if (!ended) {
        ended = true;
        controller.error(error);
      }
    };
    const readable: ReadableStream<Uint8Array> = new runtime.ReadableStream({
      start(start: ReadableStreamDefaultController<Uint8Array>) {
        controller = start;
      },
      pull() {
        // The reader has room again: Rust delivers what it held back.
        if (paused) {
          paused = false;
          registry.pause(id, false);
        }
      },
      cancel() {
        ended = true;
        registry.close(id, 1000, "");
      },
    });
    const writable: WritableStream<BufferSource> = new runtime.WritableStream({
      async write(chunk: unknown) {
        const bytes = bufferSourceBytes(chunk);
        await opened;
        await registry.write(id, bytes);
      },
      close() {
        registry.close(id, 1000, "");
      },
      abort() {
        registry.close(id, 1000, "");
      },
    });
    this.#take({
      open() {},
      message(data) {
        if (ended) {
          return;
        }
        if (typeof data === "string") {
          fail(new TypeError("A text message arrived on a byte stream"));
          // 1003: the endpoint cannot accept this type of data.
          registry.close(id, 1003, "text message on a byte stream");
          return;
        }
        controller.enqueue(data);
        // The reader is full: Rust holds further messages, and its sender
        // waits for room.
        if (!paused && (controller.desiredSize ?? 0) <= 0) {
          paused = true;
          registry.pause(id, true);
        }
      },
      close(code) {
        if (code === 1006) {
          fail(new TypeError("The channel ended without a close"));
        } else if (!ended) {
          ended = true;
          controller.close();
        }
      },
      refused(message) {
        fail(new TypeError(message));
      },
    });
    return { readable, writable };
  }

  close(code = 1000, reason = ""): void {
    this.#registry.close(this.#id, code, reason);
  }

  get [Symbol.toStringTag](): string {
    return `HostChannel ${this.#service}`;
  }
}

/** Open a channel of the env binding `service`, as `env.NAME.connect` does. */
export function connectChannel(service: string, options?: unknown): HostChannel {
  const registry = channelRegistry();
  if (!registry) {
    throw new TypeError("This host has no channels");
  }
  return new HostChannelImpl(CREATE, registry, service, options);
}

// The bridge's env bindings build their channels here. A second copy of this
// module, as a framework build may bundle, keeps the first.
if (!Object.hasOwn(runtime, "__fetchletChannelViews")) {
  Object.defineProperty(runtime, "__fetchletChannelViews", {
    value: Object.freeze({
      connect: connectChannel,
    }),
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

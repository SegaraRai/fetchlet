/* eslint-disable no-var -- Only var declarations add properties to typeof globalThis. */

// The global names the embedded scripts share with Rust and with the guest
// runtime (@fetchlet/web). Rust installs the host bindings before the bridge
// runs; the bridge defines the registries; the guest runtime installs the
// timer, async context and rejection hooks. A hook is undefined in a bundle
// that does not install it.

/** A message the host dispatcher answers, as JSON text both ways. */
type NativeDispatch = (operation: string, input: string) => string;

interface HostErrorDescription {
  code: string;
  message: string;
}

type HostReply<T> = { ok: true; value: T } | { ok: false; error: HostErrorDescription };

/** The host functions the bundle claims once with __fetchletClaimHost. */
interface HostClaim {
  call(operation: string, input: string): string;
  putBytes(bytes: Uint8Array): number;
  takeBytes(handle: number): Uint8Array<ArrayBuffer>;
  readWholeBody(
    stream: ReadableStream<Uint8Array>,
    text: boolean,
    onValue: (value: Uint8Array | string) => void,
    onError: (error: unknown) => void,
  ): boolean;
}

/** A chunk a Fetch response body yields to Rust. */
interface ResponseBodyChunk {
  chunk: Uint8Array;
  done: boolean;
}

/** Fetch response bodies Rust pulls after the handler returns. */
interface ResponseBodyRegistry {
  beginCall(streaming: boolean): void;
  endCall(): void;
  streaming(): boolean;
  openCount(): number;
  register(stream: ReadableStream<Uint8Array>): number;
  pull(id: number, waitForData: boolean): Promise<ResponseBodyChunk>;
  cancel(id: number): Promise<void>;
  retain(id: number | undefined): boolean;
  closeAll(): void;
}

/** The destination and options of a TCP connection, as Rust's socket.open takes them. */
/** What a client WebSocket's server selected in its handshake. */
interface WebSocketAccepted {
  protocol: string;
  extensions: string;
}

/** A client WebSocket JavaScript opens. */
interface WebSocketOpen {
  url: string;
  protocols: string[];
}

interface SocketOpen {
  hostname: string;
  port: number;
  secureTransport: "off" | "on" | "starttls";
}

/** What a channel delivers to the object that owns it. */
interface ChannelListener {
  /**
   * The channel is open: the handler has returned its upgrade, or the
   * service accepted the open.
   */
  open(accepted?: WebSocketAccepted): void;
  message(data: string | Uint8Array<ArrayBuffer>): void;
  close(code: number, reason: string): void;
  /** The service refused the open; nothing else arrives. */
  refused?(message: string): void;
  /** A socket's peer ended its bytes; the channel stays open for writes. */
  end?(): void;
  /** A socket's connection switched to TLS, answering `startTls`. */
  secure?(): void;
}

/** Channels of the current invocation, such as an accepted WebSocket. */
interface ChannelRegistry {
  upgrade(listener: ChannelListener): number;
  /** The channel of the upgrade this invocation accepted, if any. */
  accepted(): number | undefined;
  /** Open a channel of the env binding `service`. */
  open(service: string, options: unknown, listener: ChannelListener): number;
  /** Listen to a channel Rust lent to the current call. */
  adopt(id: number, listener: ChannelListener): void;
  /** Open a TCP connection through the host's socket service. */
  connect(address: SocketOpen, listener: ChannelListener): number;
  /** Open a client WebSocket through the host's WebSocket service. */
  websocket(request: WebSocketOpen, listener: ChannelListener): number;
  /**
   * End a socket's writes after those queued, as a TCP half close. Throws
   * unless the socket is open with no write pending.
   */
  endWrites(id: number): void;
  /**
   * Switch a socket opened with "starttls" to TLS after the bytes written
   * so far. Throws unless it is open with no write pending, once.
   */
  startTls(id: number): void;
  send(id: number, data: string | Uint8Array): void;
  /**
   * Queue bytes as binary messages within the channel budgets, resolving
   * once all are queued. One write at a time.
   */
  write(id: number, data: Uint8Array): Promise<void>;
  /** Hold arrivals back in Rust, or deliver them again. */
  pause(id: number, paused: boolean): void;
  close(id: number, code: number, reason: string): void;
  buffered(id: number): number;
  retain(id: number | undefined): boolean;
  hold(id: number): Promise<void>;
  closeAll(): void;
}

/** Work registered with fetchlet.waitUntil. */
interface BackgroundRegistry {
  pending(): number;
  settle(): Promise<void>;
  clear(): void;
}

/** The async context slot of the guest runtime. */
type StackFrames = (
  skipThrough: Function | undefined,
  limit: number,
) => [
  functionName: string | null,
  fileName: string | null,
  line: number | null,
  column: number | null,
  isEval: boolean,
][];

/** A call site of V8's stack trace API. */
interface CallSite {
  getFunctionName(): string | null;
  getFileName(): string | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  toString(): string;
}

/** V8's stack trace API, which stack-trace.ts completes. */
interface ErrorConstructor {
  captureStackTrace?(target: object, constructorOpt?: Function): void;
  prepareStackTrace?: ((error: Error, sites: CallSite[]) => unknown) | undefined;
  stackTraceLimit?: unknown;
}

interface AsyncContextSlot {
  get(): unknown;
  set(mapping: unknown): void;
}

// Host bindings, which the bridge removes from the global object.
declare var __fetchletHost: NativeDispatch | undefined;
declare var __fetchletTakeBytes: ((handle: number) => Uint8Array<ArrayBuffer>) | undefined;
declare var __fetchletPutBytes: ((bytes: Uint8Array) => number) | undefined;
/**
 * Installed by Boa for stack-trace.ts: the frames below the caller, most
 * recent first, up to `limit`, after the most recent call of `skipThrough`
 * when it is given, and none when that function is not on the stack.
 */
declare var __fetchletStackFrames: StackFrames | undefined;

// Defined by the bridge.
declare var __fetchletClaimHost: (() => HostClaim) | undefined;
declare var __fetchletResponseBodies: ResponseBodyRegistry;
declare var __fetchletBackground: BackgroundRegistry;
declare var __fetchletChannels: ChannelRegistry;
/** Installed by the Web API profile: builds the views of a channel binding. */
declare var __fetchletChannelViews:
  | {
      connect(service: string, options: unknown): unknown;
      /** The channel object of a channel Rust lent to the call. */
      lend?(id: number): unknown;
    }
  | undefined;
/**
 * Installed by the Web API profile: whether a Request's body streams, having
 * no source Fetch can read again, or undefined for another Request.
 */
declare var __fetchletStreamsBody: ((request: unknown) => boolean | undefined) | undefined;
declare var __fetchletPumpHost: (() => number) | undefined;
/** String bindings explicitly opted into `process.env` via `HostServices::process_env`. */
declare var __fetchletProcessEnv: Record<string, string> | undefined;

// Installed by the guest runtime.
declare var __fetchletAsyncContext: AsyncContextSlot | undefined;
declare var __fetchletFlushRejections: (() => void) | undefined;
declare var __fetchletRunNextTimer: (() => boolean) | undefined;
declare var __fetchletTimerDelay: (() => number | undefined) | undefined;
declare var __fetchletClearTimers: (() => void) | undefined;
declare var __fetchletClearPerformanceEntries: (() => void) | undefined;

/** The exports of the evaluated bundle. */
declare var fetchletExports: Record<string, unknown>;

/** Node's name for the global object, which runtime.ts defines. */
declare var global: typeof globalThis;

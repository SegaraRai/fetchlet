// The JSON shapes the bridge exchanges with the host dispatcher
// (src/bridge/dispatcher.rs). Byte fields carry byte store handles.

export interface Bindings {
  console: boolean;
  env: Record<string, unknown>;
  services: string[];
  channels: string[];
  functions: Record<string, FunctionMethods>;
}

/** A byte array or channel at its path in a value, by its handle. */
export interface PlacedBytes {
  path: string[];
  handle: number;
}

export interface PlacedChannel {
  path: string[];
  channel: number;
}

/** How a function call settled: its value with the resources Rust placed in it, or why it failed. */
export type FunctionOutcome =
  | {
      ok: true;
      value: unknown;
      bytes: PlacedBytes[];
      channels: PlacedChannel[];
    }
  | {
      ok: false;
      error: FunctionErrorDescription;
    };

/** The methods of a function binding, and whether each is sync or async. */
export type FunctionMethods = Record<string, "sync" | "async">;

/**
 * Why a function call failed: Rust could not read its arguments, the method
 * returned an application error, or, without a kind, a host error.
 */
export interface FunctionErrorDescription {
  kind?: "arguments" | "application";
  code: string | null;
  message: string;
}

/**
 * The budgets of reading an outbound request body, as decimal strings since
 * they may exceed a double; null is none.
 */
export interface RequestBodyLimits {
  requestBodyBytes: string | null;
  requestBodyChunks: string | null;
}

export interface WireResponse {
  status: number;
  headers: [string, string][];
  body: number | null;
  /** A Rust body source still arriving, read on demand. */
  stream?: number;
}

/** A message or the close of a channel, delivered with the completions. */
export interface ChannelArrival {
  channel: number;
  /** The service accepted the open. */
  open?: true;
  /** What a client WebSocket's server selected, with its open. */
  accepted?: {
    protocol: string;
    extensions: string;
  };
  /** The service refused the open. */
  refused?: {
    code: string;
    message: string;
  };
  /** The pending write is queued. */
  written?: true;
  text?: string;
  /** A byte store handle for a binary message. */
  bytes?: number;
  /** A socket's peer ended its bytes; the socket still writes. */
  end?: true;
  /** A socket's connection speaks TLS from here, answering startTls. */
  secure?: true;
  close?: {
    code: number;
    reason: string;
  };
}

/** The byte arrays and channels Rust placed in the arguments of a call. */
export interface CallPlaces {
  bytes: PlacedBytes[];
  channels: PlacedChannel[];
}

/** The byte arrays JavaScript sends beside a JSON value, in one buffer. */
export interface ByteLayout {
  handle: number;
  parts: {
    path: string[];
    length: number;
  }[];
}

/**
 * The ticket of a host operation that finishes later, such as a fetch, a body
 * read or an async function call: an opaque string unique to the invocation.
 */
export type Ticket = string;

/** A finished fetch, body read or async function call, by the ticket its start returned. */
export interface Completion {
  id: Ticket;
  result: HostReply<unknown>;
}

/** The request argument of a Fetch invocation, before the bridge prepares it. */
export interface InvocationRequest {
  body?: number | Uint8Array | ReadableStream<Uint8Array> | null;
  stream?: number;
  signal?: AbortSignal;
}

/** The fields of a Fetch result the bridge hands to the host. */
export interface InvocationResult {
  body?: unknown;
  stream?: number;
  /** The channel of an accepted WebSocket upgrade. */
  upgrade?: number;
}

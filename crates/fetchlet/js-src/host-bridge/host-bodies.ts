// Rust bodies read from JavaScript: request bodies Rust streams into a Fetch
// handler and response bodies of the host's fetch.

import { dispatch, hostError, takeBytes } from "./host.ts";
import type { Completion, Ticket } from "./wire.ts";

interface PendingRead {
  id: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

type ValueCallback = (value: Uint8Array | string) => void;
type ErrorCallback = (error: unknown) => void;
type WholeRead = (text: boolean, onValue: ValueCallback, onError: ErrorCallback) => boolean;
type BodyController = ReadableStreamDefaultController<Uint8Array> | ReadableByteStreamController;

// Outstanding reads of Rust bodies: ticket -> { id, resolve, reject }.
const pendingReads = new Map<Ticket, PendingRead>();
// Streams over Rust bodies that no one has read yet, and how to read each
// whole at once.
const wholeReads = new WeakMap<ReadableStream<Uint8Array>, WholeRead>();

export function hasPendingReads(): boolean {
  return pendingReads.size > 0;
}

/** Forget the reads of an earlier invocation. */
export function clearPendingReads(): void {
  pendingReads.clear();
}

/** Settle the read a completion belongs to. Returns false for other tickets. */
export function completeRead(completion: Completion): boolean {
  const read = pendingReads.get(completion.id);
  if (!read) {
    return false;
  }
  pendingReads.delete(completion.id);
  if (completion.result.ok) {
    read.resolve(completion.result.value);
  } else {
    read.reject(hostError(completion.result.error));
  }
  return true;
}

let byteStreams: boolean | undefined;

function supportsByteStreams(): boolean {
  if (byteStreams === undefined) {
    try {
      new ReadableStream({ type: "bytes" });
      byteStreams = true;
    } catch {
      byteStreams = false;
    }
  }
  return byteStreams;
}

function readHostBody(id: number): Promise<{ chunk: number; done: boolean }> {
  const ticket = dispatch<Ticket>("body.read", id);
  return new Promise((resolve, reject) => {
    pendingReads.set(ticket, {
      id,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
  });
}

// Read the rest of a Rust body as one buffer, or with `text` as a string
// Rust decoded as UTF-8. The callbacks run in the host pump, not as
// promise reactions, so they must not throw.
function readWholeHostBody(
  id: number,
  text: boolean,
  onValue: ValueCallback,
  onError: ErrorCallback,
): void {
  const ticket = dispatch<Ticket>(text ? "body.readText" : "body.readAll", id);
  pendingReads.set(ticket, {
    id,
    resolve(value) {
      if (text) {
        onValue((value as { text: string }).text);
        return;
      }
      let bytes;
      try {
        bytes = takeBytes((value as { chunk: number }).chunk);
      } catch (error) {
        onError(error);
        return;
      }
      onValue(bytes);
    },
    reject: onError,
  });
}

// Read a host body stream whole, sparing a host step and stream promises
// per chunk. Returns false when the stream is no host body or was read.
// The caller locks the stream right after, so no one else reads it.
export function readWholeBody(
  stream: ReadableStream<Uint8Array>,
  text: boolean,
  onValue: ValueCallback,
  onError: ErrorCallback,
): boolean {
  const read = wholeReads.get(stream);
  if (read === undefined) {
    return false;
  }
  wholeReads.delete(stream);
  return read(text === true, onValue, onError);
}

function cancelHostBody(id: number): void {
  for (const [ticket, pending] of pendingReads) {
    if (pending.id === id) {
      pendingReads.delete(ticket);
    }
  }
  try {
    dispatch("body.cancel", id);
  } catch {
    // The invocation may have ended, which released the body already.
  }
}

// A ReadableStream over a Rust body in the current invocation. Chunks are
// read only when the stream pulls, so Rust applies backpressure to the
// producer; cancelling the stream drops the Rust body. An abort of the
// fetch's signal errors the stream and drops the body as well.
export function hostBodyStream(id: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let controller: BodyController;
  let open = true;
  // The error callback of a whole read in progress.
  let wholeFailed: ErrorCallback | null = null;

  function finish() {
    open = false;
    wholeReads.delete(stream);
    signal?.removeEventListener("abort", abort);
  }

  function abort() {
    if (!open) {
      return;
    }
    finish();
    cancelHostBody(id);
    controller.error(signal!.reason);
    const failed = wholeFailed;
    wholeFailed = null;
    failed?.(signal!.reason);
  }

  function readWhole(text: boolean, onValue: ValueCallback, onError: ErrorCallback): boolean {
    if (!open) {
      return false;
    }
    const settle =
      <T>(callback: (value: T) => void) =>
      (value: T) => {
        wholeFailed = null;
        finish();
        callback(value);
      };
    const failed = settle(onError);
    wholeFailed = failed;
    try {
      readWholeHostBody(id, text, settle(onValue), failed);
    } catch (error) {
      failed(error);
    }
    return true;
  }

  const source = {
    start(streamController: BodyController) {
      controller = streamController;
      signal?.addEventListener("abort", abort, { once: true });
    },
    pull(streamController: BodyController) {
      // A stream read by chunks is no longer whole.
      wholeReads.delete(stream);
      return readHostBody(id).then(
        ({ chunk, done }) => {
          if (!open) {
            return;
          }
          if (done) {
            finish();
            streamController.close();
          } else {
            streamController.enqueue(takeBytes(chunk));
          }
        },
        (error) => {
          finish();
          throw error;
        },
      );
    },
    cancel() {
      if (open) {
        finish();
        cancelHostBody(id);
      }
    },
  };
  // The callbacks above run only once the stream exists.
  const stream: ReadableStream<Uint8Array> = supportsByteStreams()
    ? new ReadableStream({ ...source, type: "bytes" })
    : new ReadableStream(source, { highWaterMark: 0 });
  wholeReads.set(stream, readWhole);
  return stream;
}

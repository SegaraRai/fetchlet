// Fetch response bodies that stay open after the handler returns. Rust pulls
// them on demand. Every entry belongs to the current invocation: ids are only
// meaningful within it, and the registry is emptied when it begins and ends.

import { backgroundRegistry } from "./background.ts";
import { clearPendingReads } from "./host-bodies.ts";

interface ResponseBodyEntry {
  reader: ReadableStreamDefaultReader<unknown>;
  pending: Promise<ReadableStreamReadResult<unknown>> | null;
}

const responseBodies = new Map<number, ResponseBodyEntry>();
let nextResponseBody = 1;
let streamingCall = false;
const nextTurn = Symbol("nextTurn");
// Coalescing granularity, not a budget: stop merging available chunks into
// one bridge message at this size, so a fast producer still meets the Rust
// queue's backpressure. Limits.response_body_bytes bounds the whole body.
const coalesceBytes = 64 * 1024;

function responseChunk(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Response body must contain byte chunks");
  }
  return value;
}

// Resolve after queued promise jobs, so that reads already satisfiable
// without a timer or host event are drained into one message.
function afterQueuedJobs(timers: ReturnType<typeof setTimeout>[]): Promise<typeof nextTurn> {
  return new Promise((resolve) => {
    if (typeof globalThis.setTimeout === "function") {
      timers.push(globalThis.setTimeout(() => resolve(nextTurn), 0));
    } else {
      resolve(nextTurn);
    }
  });
}

async function drain(entry: ResponseBodyEntry, waitForData: boolean): Promise<ResponseBodyChunk> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let done = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  try {
    while (byteLength < coalesceBytes) {
      entry.pending ??= entry.reader.read();
      const mustWait = waitForData && byteLength === 0;
      const result = mustWait
        ? await entry.pending
        : await Promise.race([entry.pending, afterQueuedJobs(timers)]);
      if (result === nextTurn) {
        break;
      }
      entry.pending = null;
      if (result.done) {
        done = true;
        break;
      }
      const chunk = responseChunk(result.value);
      if (chunk.byteLength > 0) {
        chunks.push(chunk);
        byteLength += chunk.byteLength;
      }
    }
  } finally {
    for (const timer of timers) {
      globalThis.clearTimeout?.(timer);
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    chunk: bytes,
    done,
  };
}

export const responseBodyRegistry: ResponseBodyRegistry = Object.freeze<ResponseBodyRegistry>({
  beginCall(streaming) {
    // Nothing from an earlier invocation is reachable from this one.
    responseBodyRegistry.closeAll();
    clearPendingReads();
    backgroundRegistry.clear();
    streamingCall = streaming;
  },
  endCall() {
    streamingCall = false;
  },
  // True while a Fetch handler called by a streaming-capable host runs.
  streaming() {
    return streamingCall;
  },
  openCount() {
    return responseBodies.size;
  },
  register(stream) {
    const id = nextResponseBody++;
    responseBodies.set(id, { reader: stream.getReader(), pending: null });
    return id;
  },
  async pull(id, waitForData) {
    const entry = responseBodies.get(id);
    if (!entry) {
      throw new TypeError("Unknown response body");
    }
    try {
      const result = await drain(entry, waitForData);
      if (result.done) {
        responseBodies.delete(id);
      }
      return result;
    } catch (error) {
      responseBodies.delete(id);
      throw error;
    }
  },
  async cancel(id) {
    const entry = responseBodies.get(id);
    responseBodies.delete(id);
    await entry?.reader.cancel().catch(() => {});
  },
  // Keep only the body handed to the host in the Fetch result; cancel the
  // rest. Returns whether that body is still open.
  retain(id) {
    for (const [key, entry] of responseBodies) {
      if (key !== id) {
        responseBodies.delete(key);
        void entry.reader.cancel().catch(() => {});
      }
    }
    return id !== undefined && responseBodies.has(id);
  },
  closeAll() {
    for (const entry of responseBodies.values()) {
      void entry.reader.cancel().catch(() => {});
    }
    responseBodies.clear();
  },
});

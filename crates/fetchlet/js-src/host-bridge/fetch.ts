// The host's fetch: requests go to Rust, which authorizes each with its
// FetchPolicy, and responses come back in the host pump. A body with a
// source, such as bytes or a string, is read first, so Rust can resend it on
// a redirect; a ReadableStream body streams as the transport sends it, as
// browsers stream it, one chunk for each pull Rust delivers in the pump.

import { hostBodyStream } from "./host-bodies.ts";
import { dispatch, hostError, putBytes, takeBytes } from "./host.ts";
import type { Completion, RequestBodyLimits, Ticket, WireResponse } from "./wire.ts";

interface PendingFetch {
  resolve(response: Response): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  cleanup(): void;
}

const pendingFetches = new Map<Ticket, PendingFetch>();

/** The reader of each body streaming to Rust, by its upload ticket. */
const uploads = new Map<Ticket, ReadableStreamDefaultReader<unknown>>();

export function hasPendingFetches(): boolean {
  return pendingFetches.size > 0 || uploads.size > 0;
}

function endUpload(ticket: Ticket, reason?: unknown): void {
  const reader = uploads.get(ticket);
  if (reader === undefined) {
    return;
  }
  uploads.delete(ticket);
  void reader.cancel(reason).catch(() => {});
}

/** Send Rust the next chunk of an upload, its end, or its failure. */
async function pullUpload(ticket: Ticket): Promise<void> {
  const reader = uploads.get(ticket);
  if (reader === undefined) {
    return;
  }
  let write: {
    ticket: Ticket;
    chunk?: number;
    done?: true;
    error?: true;
  };
  try {
    const { value, done } = await reader.read();
    if (done) {
      write = {
        ticket,
        done: true,
      };
    } else if (value instanceof Uint8Array) {
      // Store the bytes right before the message that takes them.
      write = {
        ticket,
        chunk: putBytes(value),
      };
    } else {
      throw new TypeError("Request body must contain byte chunks");
    }
  } catch {
    write = {
      ticket,
      error: true,
    };
  }
  if (!uploads.has(ticket)) {
    // Rust cancelled the upload while the read waited.
    return;
  }
  if (write.error === true) {
    endUpload(ticket, new TypeError("Request body stream failed"));
  } else if (write.done === true) {
    uploads.delete(ticket);
  }
  try {
    dispatch("fetch.upload", write);
  } catch (error) {
    // A budget, or the end of the fetch, stops the stream.
    endUpload(ticket, error);
  }
}

/** Deliver a pull or a cancel of an upload; false if it is not one. */
function completeUpload(completion: Completion): boolean {
  if (!uploads.has(completion.id)) {
    return false;
  }
  if (completion.result.ok && completion.result.value === "pull") {
    void pullUpload(completion.id);
  } else {
    endUpload(completion.id);
  }
  return true;
}

function exceedsBudget(observed: number, budget: string | null): boolean {
  return budget !== null && BigInt(observed) > BigInt(budget);
}

async function readRequestBody(
  request: Request,
  limits: RequestBodyLimits,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;

  function abortBodyRead() {
    void reader.cancel(request.signal.reason).catch(() => {});
  }

  request.signal.addEventListener("abort", abortBodyRead, { once: true });

  try {
    while (true) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      request.signal.throwIfAborted();

      if (done) {
        break;
      }

      chunkCount += 1;
      if (exceedsBudget(chunkCount, limits.requestBodyChunks)) {
        await reader.cancel();
        throw hostError({
          code: "LIMIT_EXCEEDED",
          message: "Request body has too many chunks",
        });
      }

      if (!(value instanceof Uint8Array)) {
        throw new TypeError("Request body must contain byte chunks");
      }

      byteLength += value.byteLength;
      if (exceedsBudget(byteLength, limits.requestBodyBytes)) {
        await reader.cancel();
        throw hostError({
          code: "LIMIT_EXCEEDED",
          message: "Request body exceeds the bridge limit",
        });
      }

      if (value.byteLength > 0) {
        chunks.push(value);
      }
    }
  } finally {
    request.signal.removeEventListener("abort", abortBodyRead);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function responseFromWire(response: WireResponse, signal: AbortSignal): Response {
  const hasNoBody = [204, 205, 304].includes(response.status);
  let body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | null = null;
  if (typeof response.stream === "number") {
    // The upstream body is still arriving; read it on demand.
    body = hostBodyStream(response.stream, signal);
  } else if (!hasNoBody) {
    body = takeBytes(response.body!);
  }

  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}

/** Settle the fetch a completion belongs to, if it is still waiting. */
export function completeFetch(completion: Completion): void {
  if (completeUpload(completion)) {
    return;
  }

  const pending = pendingFetches.get(completion.id);
  if (!pending) {
    return;
  }

  pendingFetches.delete(completion.id);
  pending.cleanup();

  if (completion.result.ok) {
    pending.resolve(responseFromWire(completion.result.value as WireResponse, pending.signal));
  } else {
    pending.reject(hostError(completion.result.error));
  }
}

function waitForResponse(
  ticket: Ticket,
  upload: Ticket | null,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    function abort() {
      if (upload !== null) {
        endUpload(upload, signal.reason);
      }
      if (!pendingFetches.delete(ticket)) {
        return;
      }

      try {
        dispatch("fetch.cancel", ticket);
      } catch {
        // The invocation may have closed before this abort notification.
      }

      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    }

    pendingFetches.set(ticket, {
      resolve,
      reject,
      signal,
      cleanup: () => signal.removeEventListener("abort", abort),
    });

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

export async function hostFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  service?: string,
): Promise<Response> {
  const request = new Request(input, init);
  request.signal.throwIfAborted();

  // Without the Web API profile's Request, every body is read first.
  const streams = globalThis.__fetchletStreamsBody?.(request) === true && request.body !== null;
  if (streams && request.body.locked) {
    throw new TypeError("Request body is already used");
  }
  const limits = dispatch<RequestBodyLimits>("fetch.limits", null);
  const body = streams ? null : await readRequestBody(request, limits);
  request.signal.throwIfAborted();

  // Store the bytes right before the message that takes them.
  const started = dispatch<{ ticket: Ticket; upload: Ticket | null }>("fetch.start", {
    service: service ?? null,
    redirect: request.redirect,
    upload: streams,
    request: {
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers),
      body: body === null ? null : putBytes(body),
    },
  });
  if (started.upload !== null) {
    uploads.set(started.upload, request.body!.getReader());
  }

  return waitForResponse(started.ticket, started.upload, request.signal);
}

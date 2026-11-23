// The entry points Rust evaluates for each invocation (src/execution/script.rs).

import { backgroundRegistry } from "./background.ts";
import { channelRegistry } from "./channels.ts";
import { hostBodyStream } from "./host-bodies.ts";
import { dispatch, putBytes, takeBytes } from "./host.ts";
import { responseBodyRegistry } from "./response-bodies.ts";
import type { InvocationRequest, InvocationResult, LentChannel } from "./wire.ts";

// Aborts the request signal of the Fetch invocation in progress when its
// client goes away: Rust cancels the response body, or reports through
// invocation.disconnected that the caller left while a call runs on.
let requestAbort: AbortController | null = null;

function abortRequest(): void {
  const controller = requestAbort;
  requestAbort = null;
  controller?.abort();
}

/** Abort the request signal if the client left. Returns whether it did. */
export function abortIfDisconnected(): boolean {
  if (requestAbort !== null && dispatch<boolean>("invocation.disconnected", null)) {
    abortRequest();
    return true;
  }
  return false;
}

function clearInvocation(): void {
  requestAbort = null;
  responseBodyRegistry.closeAll();
  // Background work keeps its channels and timers until Rust settles it.
  if (backgroundRegistry.pending() === 0) {
    channelRegistry.closeAll();
    globalThis.__fetchletClearTimers?.();
    globalThis.__fetchletClearPerformanceEntries?.();
  }
}

/** Put each channel Rust lent to the call at its place in the arguments. */
function placeLentChannels(argumentsList: unknown[], lent: LentChannel[]): void {
  if (lent.length === 0) {
    return;
  }
  const views = globalThis.__fetchletChannelViews;
  if (!views?.lend) {
    throw new TypeError("Channels need the fetchlet Web API profile");
  }
  for (const { path, channel } of lent) {
    // Rust checked that each path names a value of the JSON arguments.
    const key = path[path.length - 1];
    if (key === undefined) {
      throw new TypeError("A lent channel needs a place in the arguments");
    }
    let parent = argumentsList as unknown as Record<string, unknown>;
    for (const token of path.slice(0, -1)) {
      parent = parent[token] as Record<string, unknown>;
    }
    // A data property, even for a key such as "__proto__".
    Object.defineProperty(parent, key, {
      value: views.lend(channel),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

// Call an exported function. With streamResponseBody, it is a Fetch
// handler: its request body arrives through the byte store or as a Rust
// body source, and a response body it leaves open keeps the invocation,
// with its timers, open until Rust finishes or cancels that body. Channels
// Rust lent to a call become channel objects in its arguments.
export async function invokeExport(
  exportName: string,
  argumentsList: unknown[],
  streamResponseBody?: boolean,
  lent: LentChannel[] = [],
): Promise<string> {
  // Each invocation starts in the empty async context, whatever the
  // previous one left current.
  globalThis.__fetchletAsyncContext?.set(undefined);
  const exports = globalThis.fetchletExports;
  let invocationRemainsOpen = false;
  responseBodyRegistry.beginCall(streamResponseBody === true);
  channelRegistry.closeAll();

  try {
    if (!Object.hasOwn(exports, exportName)) {
      throw new TypeError("Unknown function");
    }

    const exportedFunction = exports[exportName];
    if (typeof exportedFunction !== "function") {
      throw new TypeError("Unknown function");
    }
    placeLentChannels(argumentsList, lent);

    if (streamResponseBody === true) {
      const request = argumentsList[0] as InvocationRequest | null;
      if (typeof globalThis.AbortController === "function" && request !== null) {
        requestAbort = new globalThis.AbortController();
        // Not JSON: wireRequest passes it to the Request it builds.
        request.signal = requestAbort.signal;
      }
      if (typeof request?.body === "number") {
        request.body = takeBytes(request.body);
      } else if (typeof request?.stream === "number") {
        request.body = hostBodyStream(request.stream);
        delete request.stream;
      }
    }

    let result = (await exportedFunction(...argumentsList)) as InvocationResult | null | undefined;
    if (streamResponseBody === true) {
      // Hand a typed-array response body to Rust through the byte store.
      const body = result?.body;
      if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
        const bytes = ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : new Uint8Array(body);
        result = {
          ...result,
          body: putBytes(bytes),
        };
      }
    }
    const serializedResult = JSON.stringify(result);

    if (serializedResult === undefined) {
      throw new TypeError("Result is not JSON serializable");
    }

    // Only the body or the upgrade the result hands to the host stays open
    // with the invocation.
    if (streamResponseBody === true) {
      const bodyOpen = responseBodyRegistry.retain(result?.stream);
      const connectionOpen = channelRegistry.retain(result?.upgrade);
      invocationRemainsOpen = bodyOpen || connectionOpen;
    }
    return serializedResult;
  } finally {
    responseBodyRegistry.endCall();
    if (!invocationRemainsOpen) {
      clearInvocation();
    }
  }
}

// Hold the connection a Fetch invocation accepted until it closes. Its
// messages, timers and host operations run in the invocation meanwhile.
export async function invokeConnection(channel: number): Promise<string> {
  globalThis.__fetchletAsyncContext?.set(undefined);
  try {
    await channelRegistry.hold(channel);
    return "null";
  } finally {
    clearInvocation();
  }
}

// Pull from or cancel the response body a Fetch invocation left open. The
// invocation ends with the body: on its last chunk, a cancel or an error.
export async function invokeResponseBody(operation: string, bodyId: number): Promise<string> {
  // Body pulls start in the empty async context; the stream's own promise
  // reactions keep theirs.
  globalThis.__fetchletAsyncContext?.set(undefined);
  let invocationEnds = true;

  try {
    if (operation === "pull") {
      const result = await responseBodyRegistry.pull(bodyId, true);
      invocationEnds = result.done;
      return JSON.stringify({
        chunk: putBytes(result.chunk),
        done: result.done,
      });
    }
    if (operation === "cancel") {
      // The client went away: the handler sees its request abort before
      // its body is cancelled.
      abortRequest();
      await responseBodyRegistry.cancel(bodyId);
      return "null";
    }
    throw new TypeError("Unknown response body operation");
  } finally {
    if (invocationEnds) {
      clearInvocation();
    }
  }
}

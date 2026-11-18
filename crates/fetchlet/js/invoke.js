// Rust calls this declaration as an expression (execution/script.rs).

// eslint-disable-next-line no-unused-vars
async function invokeExport(exportName, argumentsList, streamResponseBody) {
  // Each invocation starts in the empty async context, whatever the previous
  // one left current.
  globalThis.__fetchletAsyncContext?.set(undefined);
  const exports = globalThis.fetchletExports;
  const bodies = globalThis.__fetchletResponseBodies;
  // A Fetch call may leave its response body open; the invocation then stays
  // open, with its timers, until Rust finishes or cancels that body.
  let invocationRemainsOpen = false;
  bodies?.beginCall(streamResponseBody === true);

  try {
    if (!Object.hasOwn(exports, exportName)) {
      throw new TypeError("Unknown function");
    }

    const exportedFunction = exports[exportName];
    if (typeof exportedFunction !== "function") {
      throw new TypeError("Unknown function");
    }

    if (streamResponseBody === true) {
      // A Fetch request body arrives as a byte-store handle, or as a Rust
      // body source that the handler reads as a ReadableStream.
      const request = argumentsList[0];
      if (typeof request?.body === "number") {
        request.body = globalThis.__fetchletTakeBytes(request.body);
      } else if (typeof request?.stream === "number") {
        request.body = globalThis.__fetchletHostBodies.stream(request.stream);
        delete request.stream;
      }
    }

    let result = await exportedFunction(...argumentsList);
    if (streamResponseBody === true) {
      // Hand a typed-array response body to Rust through the byte store.
      const body = result?.body;
      if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
        const bytes = ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : new Uint8Array(body);
        result = {
          ...result,
          body: globalThis.__fetchletPutBytes(bytes),
        };
      }
    }
    const serializedResult = JSON.stringify(result);

    if (serializedResult === undefined) {
      throw new TypeError("Result is not JSON serializable");
    }

    // Only the body the result hands to the host stays open with the invocation.
    if (streamResponseBody === true && bodies) {
      invocationRemainsOpen = bodies.retain(result?.stream);
    }
    return serializedResult;
  } finally {
    bodies?.endCall();
    if (!invocationRemainsOpen) {
      bodies?.closeAll();
      // Background work keeps its timers until Rust settles it.
      if ((globalThis.__fetchletBackground?.pending() ?? 0) <= 0) {
        globalThis.__fetchletClearTimers?.();
        globalThis.__fetchletClearPerformanceEntries?.();
      }
    }
  }
}

async function invokeExport(exportName, argumentsList, streamResponseBody) {
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

    const result = await exportedFunction(...argumentsList);
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
      globalThis.__fetchletClearTimers?.();
    }
  }
}

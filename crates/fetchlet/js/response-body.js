async function invokeResponseBody(operation, bodyId) {
  const bodies = globalThis.__fetchletResponseBodies;
  // The invocation ends with the body: on its last chunk, a cancel or an error.
  let invocationEnds = true;

  try {
    if (operation === "pull") {
      const result = await bodies.pull(bodyId, true);
      invocationEnds = result.done;
      const chunk = globalThis.__fetchletPutBytes(result.chunk);
      return JSON.stringify({
        chunk,
        done: result.done,
      });
    }
    if (operation === "cancel") {
      await bodies.cancel(bodyId);
      return "null";
    }
    throw new TypeError("Unknown response body operation");
  } finally {
    if (invocationEnds) {
      bodies.closeAll();
      globalThis.__fetchletClearTimers?.();
    }
  }
}

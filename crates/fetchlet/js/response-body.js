async function invokeResponseBody(operation, bodyId) {
  const bodies = globalThis.__fetchletResponseBodies;
  // The invocation ends with the body: on its last chunk, a cancel or an error.
  let invocationEnds = true;

  try {
    if (operation === "pull") {
      const result = await bodies.pull(bodyId, true);
      invocationEnds = result.done;
      return JSON.stringify(result);
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

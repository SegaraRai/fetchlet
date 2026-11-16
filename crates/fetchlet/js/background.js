(async () => {
  // Settle fetchlet.waitUntil work, then end the invocation like a result does.
  try {
    await globalThis.__fetchletBackground.settle();
  } finally {
    globalThis.__fetchletResponseBodies?.closeAll();
    globalThis.__fetchletClearTimers?.();
  }
  return "null";
})();

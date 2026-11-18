// The script's value is this promise, which Rust drives to completion.
// eslint-disable-next-line typescript/no-floating-promises
(async () => {
  // Settle fetchlet.waitUntil work, then end the invocation like a result does.
  try {
    await globalThis.__fetchletBackground.settle();
  } finally {
    globalThis.__fetchletResponseBodies?.closeAll();
    globalThis.__fetchletClearTimers?.();
    globalThis.__fetchletClearPerformanceEntries?.();
  }
  return "null";
})();

// The script's value is this promise, which Rust drives to completion.

// eslint-disable-next-line typescript/no-floating-promises
(async () => {
  // Background work keeps the context it was registered in through its own
  // promise reactions; settling it starts in the empty context.
  globalThis.__fetchletAsyncContext?.set(undefined);
  // Settle fetchlet.waitUntil work, then end the invocation like a result does.
  try {
    await globalThis.__fetchletBackground.settle();
  } finally {
    globalThis.__fetchletResponseBodies?.closeAll();
    globalThis.__fetchletChannels?.closeAll();
    globalThis.__fetchletClearTimers?.();
    globalThis.__fetchletClearPerformanceEntries?.();
  }
  return "null";
})();

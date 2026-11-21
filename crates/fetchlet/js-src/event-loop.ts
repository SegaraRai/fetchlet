(() => {
  // A host task starts in the empty async context. Timers and messages run
  // in the snapshots they captured; fetch completions resume promise
  // reactions, which keep their own.
  globalThis.__fetchletAsyncContext?.set(undefined);
  // Rejections still unhandled after the microtask checkpoint that preceded
  // this step are notified first (HTML "notify about rejected promises").
  globalThis.__fetchletFlushRejections?.();
  const completedFetches = globalThis.__fetchletPumpHost?.() ?? 0;
  const timerFired = globalThis.__fetchletRunNextTimer?.() ?? false;
  const delay = globalThis.__fetchletTimerDelay?.();

  return JSON.stringify({
    progress: completedFetches > 0 || timerFired === true,
    delay:
      typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null,
  });
})();

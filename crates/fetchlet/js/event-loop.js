(() => {
  const completedFetches = globalThis.__fetchletPumpHost?.() ?? 0;
  const timerFired = globalThis.__fetchletRunNextTimer?.() ?? false;
  const delay = globalThis.__fetchletTimerDelay?.();

  return JSON.stringify({
    progress: completedFetches > 0 || timerFired === true,
    delay: Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null,
  });
})();

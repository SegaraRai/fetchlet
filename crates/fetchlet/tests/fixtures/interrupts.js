// JavaScript that never returns to the event loop, for the deadline to stop.

globalThis.fetchletExports = {
  /** Return at once. */
  ready() {
    return "ready";
  },
  /** Loop forever. */
  spin() {
    for (;;) {}
  },
  /** Loop forever inside try/catch, which must not catch the stop. */
  caught() {
    try {
      for (;;) {}
    } catch {
      return "caught";
    }
  },
  /** Loop forever in a promise reaction, after the first await. */
  async later() {
    await Promise.resolve();
    try {
      for (;;) {}
    } catch {
      return "caught";
    }
  },
  /** Queue microtasks forever, so the job queue never empties. */
  microtasks() {
    return new Promise(() => {
      const next = () => Promise.resolve().then(next);
      next();
    });
  },
  /** Backtrack exponentially in a regular expression. */
  backtrack() {
    return /^(a+)+$/.test(`${"a".repeat(64)}b`);
  },
  /** Recurse without end within the stack, each call doubling the work. */
  recurse() {
    const work = (depth) => (depth === 0 ? 1 : work(depth - 1) + work(depth - 1));
    return work(64);
  },
};

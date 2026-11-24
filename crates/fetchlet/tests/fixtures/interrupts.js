// JavaScript that never returns to the event loop, for the deadline and the
// busy timeout to stop.

const CLOCK = fetchlet.env.CLOCK;

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
  /** Call the host forever without awaiting, catching what it throws. */
  host() {
    for (;;) {
      try {
        CLOCK.tick();
      } catch {
        // The stop is not catchable; anything else is ignored.
      }
    }
  },
  /** Backtrack exponentially in a regular expression. */
  backtrack() {
    return /^(a+)+$/.test(`${"a".repeat(64)}b`);
  },
  /** Recurse within the stack, each call doubling the work: 2^32 calls. */
  recurse() {
    const work = (depth) => (depth === 0 ? 1 : work(depth - 1) + work(depth - 1));
    return work(32);
  },
  /** Run longer than the busy timeout in total, awaiting the host often. */
  async patient(steps) {
    for (let step = 0; step < steps; step += 1) {
      await CLOCK.sleep();
    }
    return "patient";
  },
};

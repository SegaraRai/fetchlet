// An instance that runs in a child process: calls that cross the process
// boundary, host functions that resolve later, and JavaScript the parent
// has to stop.

const DELAY = fetchlet.env.DELAY;

globalThis.fetchletExports = {
  echo: (value) => value,

  fail() {
    throw new Error("guest failure");
  },

  /** Await a host function that resolves later, `count` times. */
  async delayed(count) {
    let total = 0;
    for (let step = 0; step < count; step += 1) {
      total += await DELAY.wait(step);
    }
    return total;
  },

  /** Loop forever without calling the host. */
  spin() {
    for (;;) {}
  },

  /** Allocate until something stops it. */
  grow() {
    const parts = [];
    for (;;) {
      parts.push(`${parts.length}`.padEnd(1 << 20, "x"));
    }
  },

  handle: (request) => ({
    status: 201,
    headers: [["x-method", request.method]],
    body: request.body ?? new Uint8Array(),
  }),
};

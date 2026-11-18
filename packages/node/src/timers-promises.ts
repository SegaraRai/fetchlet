// node:timers/promises: promise forms of the timers, with AbortSignal support,
// an async iterator for intervals and the scheduler object.

import { scheduler, setImmediate, setInterval, setTimeout } from "./internal/timers/promises.ts";

export { scheduler, setImmediate, setInterval, setTimeout };

export default {
  setTimeout,
  setImmediate,
  setInterval,
  scheduler,
};

// node:timers, setImmediate and clearImmediate over the profile's timers.

import {
  clearImmediate,
  clearInterval,
  clearTimeout,
  setImmediate,
  setInterval,
  setTimeout,
} from "./internal/timers/timers.ts";

export { clearImmediate, clearInterval, clearTimeout, setImmediate, setInterval, setTimeout };

export default {
  setTimeout,
  setInterval,
  setImmediate,
  clearTimeout,
  clearInterval,
  clearImmediate,
};

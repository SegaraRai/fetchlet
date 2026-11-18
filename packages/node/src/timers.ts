// node:timers, setImmediate and clearImmediate over the profile's timers.

import {
  clearImmediate,
  clearInterval,
  clearTimeout,
  Immediate,
  setImmediate,
  setInterval,
  setTimeout,
  Timeout,
} from "./internal/timers/timers.ts";

export {
  clearImmediate,
  clearInterval,
  clearTimeout,
  Immediate,
  setImmediate,
  setInterval,
  setTimeout,
  Timeout,
};

export default {
  setTimeout,
  setInterval,
  setImmediate,
  clearTimeout,
  clearInterval,
  clearImmediate,
  Timeout,
  Immediate,
};

// node:events: EventEmitter with Node's listener order, `newListener` and
// `removeListener` events, `error` handling, errorMonitor and max-listener
// warnings, and the module's once, on, getEventListeners, setMaxListeners and
// addAbortListener helpers.

import {
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  EventEmitter,
  getEventListeners,
  listenerCount,
  on,
  once,
  setMaxListeners,
  defaultMaxListeners,
  getMaxListeners,
} from "./internal/events/event-emitter.ts";

export {
  defaultMaxListeners,
  getMaxListeners,
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  EventEmitter,
  getEventListeners,
  listenerCount,
  on,
  once,
  setMaxListeners,
};

export default EventEmitter;

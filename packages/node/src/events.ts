// node:events: EventEmitter with Node's listener order, `newListener` and
// `removeListener` events, `error` handling, errorMonitor and max-listener
// warnings, and the module's once, on, getEventListeners, setMaxListeners and
// addAbortListener helpers.

export {
  addAbortListener,
  captureRejectionSymbol,
  EventEmitter as default,
  defaultMaxListeners,
  errorMonitor,
  EventEmitter,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  on,
  once,
  setMaxListeners,
} from "./internal/events/event-emitter.ts";

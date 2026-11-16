import { AsyncLocalStorage } from "node:async_hooks";

// One store for every copy of this module in the artifact: the server build
// and the fetchlet entry each bundle their own.
const storage = (globalThis[Symbol.for("fetchlet.vinext.context")] ??= new AsyncLocalStorage());

/** Run `callback` with `context` as the fetchlet request context. */
export function runWithRequestContext(context, callback) {
  return storage.run(context, callback);
}

/** The fetchlet request context of the current request. */
export function getRequestContext() {
  const context = storage.getStore();
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

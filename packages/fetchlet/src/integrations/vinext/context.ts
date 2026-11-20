import { AsyncLocalStorage } from "node:async_hooks";

import type { FetchletBindings as Bindings, ServiceBinding } from "fetchlet/bindings";

/**
 * The fixed host bindings of the fetchlet App: the keys applications declare
 * on `FetchletBindings` of fetchlet/bindings.
 */
export interface FetchletBindings extends Bindings {}

export type { ServiceBinding };

/** The request context the fetchlet entry passes to vinext. */
export interface FetchletRequestContext {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Readonly<FetchletBindings>;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

const storageKey = Symbol.for("fetchlet.vinext.context");
const registry = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<FetchletRequestContext>;
};

// One store for every copy of this module in the artifact: the server build
// and the fetchlet entry each bundle their own.
const storage = (registry[storageKey] ??= new AsyncLocalStorage<FetchletRequestContext>());

/** Run `callback` with `context` as the fetchlet request context. */
export function runWithRequestContext<T>(context: FetchletRequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** The fetchlet request context of the current request. Throws outside a server request. */
export function getRequestContext(): FetchletRequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

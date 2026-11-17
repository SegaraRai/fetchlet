import { AsyncLocalStorage } from "node:async_hooks";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
export interface FetchletBindings {}

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

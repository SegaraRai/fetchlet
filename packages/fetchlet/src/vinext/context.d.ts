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

/** Run `callback` with `context` as the fetchlet request context. */
export function runWithRequestContext<T>(context: FetchletRequestContext, callback: () => T): T;

/** The fetchlet request context of the current request. Throws outside a server request. */
export function getRequestContext(): FetchletRequestContext;

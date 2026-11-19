import { getRequestEvent } from "@solidjs/web";

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
export interface FetchletBindings {}

/** The request context the fetchlet entry puts on Solid's request event. */
export interface FetchletRequestContext {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Readonly<FetchletBindings>;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

/**
 * The fetchlet request context of the current request, or of `event`, in
 * middleware, API routes and server functions. Throws outside a server
 * request.
 */
export function getRequestContext(
  event: object | undefined = getRequestEvent(),
): FetchletRequestContext {
  const context = (event as { fetchlet?: FetchletRequestContext } | undefined)?.fetchlet;
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

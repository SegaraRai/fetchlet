import { getRequest } from "waku/router/server";

import { contextKey } from "./symbol.ts";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
export interface FetchletBindings {}

/** The request context the fetchlet entry passes to Waku. */
export interface FetchletRequestContext {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Readonly<FetchletBindings>;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

/**
 * The fetchlet request context of the current request. Waku passes API
 * handlers a copy of the request, so call it without `request` there.
 *
 * @param request the Request object the fetchlet entry received
 */
export function getRequestContext(request: Request = getRequest()): FetchletRequestContext {
  const context = (request as Request & { [contextKey]?: FetchletRequestContext })?.[contextKey];
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

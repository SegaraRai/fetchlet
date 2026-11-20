import type { FetchletBindings as Bindings, ServiceBinding } from "fetchlet/bindings";
import { getRequest } from "waku/router/server";

import { contextKey } from "./symbol.ts";

/**
 * The fixed host bindings of the fetchlet App: the keys applications declare
 * on `FetchletBindings` of fetchlet/bindings.
 */
export interface FetchletBindings extends Bindings {}

export type { ServiceBinding };

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

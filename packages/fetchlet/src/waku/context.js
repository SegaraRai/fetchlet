import { getRequest } from "waku/router/server";
import { contextKey } from "./symbol.js";

/**
 * The fetchlet request context of the current request. Waku passes API
 * handlers a copy of the request, so call it without `request` there.
 *
 * @param {Request} [request] the Request object the fetchlet entry received
 */
export function getRequestContext(request = getRequest()) {
  const context = request?.[contextKey];
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

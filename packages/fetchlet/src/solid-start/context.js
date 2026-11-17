import { getRequestEvent } from "solid-js/web";

/**
 * The fetchlet request context of the current SolidStart request.
 *
 * @param {import("@solidjs/start/server").FetchEvent} [event]
 */
export function getRequestContext(event = getRequestEvent()) {
  const context = event?.nativeEvent?.runtime?.fetchlet;
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

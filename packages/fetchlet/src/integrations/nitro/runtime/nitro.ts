// Nitro's server entry for the fetchlet preset.

import wsAdapter from "crossws/adapters/deno";
import { toWebHandler } from "h3";
import { useNitroApp } from "nitropack/runtime";

import "#nitro-internal-pollyfills";

const nitroApp = useNitroApp();
const web = toWebHandler(nitroApp.h3App);

// With `experimental.websocket`, crossws's Deno adapter serves upgrades; the
// preset gives it `upgradeWebSocket` from fetchlet/runtime/handler in place of
// `Deno.upgradeWebSocket`, which has the same shape.
const websocket = import.meta._websocket ? wsAdapter(nitroApp.h3App.websocket) : undefined;

function asksForWebSocket(request: Request): boolean {
  const upgrade = request.headers.get("upgrade") ?? "";
  return upgrade.split(",").some((token) => token.trim().toLowerCase() === "websocket");
}

/**
 * Handle a Fetch Request with the Nitro app. The context becomes
 * `event.context`: h3 reads `clientAddress` for getRequestIP, and Nitro
 * registers `event.waitUntil` work through `waitUntil`. A WebSocket upgrade
 * goes to the app's `defineWebSocketHandler` routes.
 */
export function handler(
  request: Request,
  context: { clientAddress?: string; [key: string]: unknown } = {},
): Promise<Response> {
  if (websocket && asksForWebSocket(request)) {
    // The adapter reads only the client address of Deno's handler info.
    const info = {
      remoteAddr: {
        hostname: context.clientAddress,
      },
    };
    return websocket.handleUpgrade(
      request,
      info as unknown as Parameters<typeof websocket.handleUpgrade>[1],
    );
  }
  return web(request, context);
}

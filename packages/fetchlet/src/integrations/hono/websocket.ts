import {
  upgradeWebSocket as upgrade,
  type UpgradeWebSocketOptions,
} from "fetchlet/runtime/handler";
import { WSContext, defineWebSocketHelper, type UpgradeWebSocket } from "hono/ws";

function asksForWebSocket(header: string | undefined): boolean {
  return (header ?? "").split(",").some((token) => token.trim().toLowerCase() === "websocket");
}

/**
 * Hono's WebSocket helper for the fetchlet App host, over `upgradeWebSocket`
 * from `fetchlet/runtime/handler`. A request that does not ask for a WebSocket goes
 * to the next handler. The handler's invocation, and with it the closures
 * of `events`, stay held until the connection closes; Rust bounds such
 * connections with `Instances::max_held_connections`.
 */
export const upgradeWebSocket: UpgradeWebSocket<WebSocket, UpgradeWebSocketOptions> =
  defineWebSocketHelper<WebSocket, UpgradeWebSocketOptions>((c, events, options) => {
    if (!asksForWebSocket(c.req.header("upgrade"))) {
      return;
    }
    // The first subprotocol the client offers, unless the options choose.
    const offered = c.req.header("sec-websocket-protocol")?.split(",")[0]?.trim();
    const { socket, response } = upgrade(c.req.raw, {
      ...(offered ? { protocol: offered } : {}),
      ...options,
    });
    const context = new WSContext<WebSocket>({
      close: (code, reason) => socket.close(code, reason),
      get protocol() {
        return socket.protocol;
      },
      raw: socket,
      get readyState() {
        return socket.readyState as 0 | 1 | 2 | 3;
      },
      url: socket.url,
      send: (source) => socket.send(source),
    });
    socket.addEventListener("open", (event) => events.onOpen?.(event, context));
    socket.addEventListener("message", (event) => events.onMessage?.(event, context));
    socket.addEventListener("close", (event) => events.onClose?.(event, context));
    socket.addEventListener("error", (event) => events.onError?.(event, context));
    return response;
  });

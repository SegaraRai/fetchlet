// Server WebSockets in a Fetch handler of the fetchlet App host.
// `upgradeWebSocket(request)` accepts the upgrade, in the shape Deno uses: it
// returns the socket and the response the handler returns. The invocation,
// and with it the instance, stays open until the connection closes.

import { channelRegistry } from "../channels/registry";
import { runtime } from "../runtime/runtime";
import { domString } from "../webidl/idl";
import { openSocket } from "./websocket";

/**
 * The channel an upgrade response hands to the host. A registered symbol, so
 * that the wire encoder finds it when a framework build bundles another copy
 * of this module. A forged value names no upgrade the host accepted.
 */
const UPGRADE = Symbol.for("fetchlet.websocket.upgrade");

function asksForWebSocket(request: Request): boolean {
  const upgrade = request.headers.get("upgrade") ?? "";
  return upgrade.split(",").some((token) => token.trim().toLowerCase() === "websocket");
}

export interface UpgradeWebSocketOptions {
  /** The subprotocol the server selects, sent as `Sec-WebSocket-Protocol`. */
  protocol?: string;
  /**
   * Other headers of the 101 response, such as cookies. A
   * `Sec-WebSocket-Protocol` among them selects the subprotocol when
   * `protocol` does not.
   */
  headers?: HeadersInit;
}

/**
 * Accept the WebSocket upgrade a Fetch request asks for. Return `response`
 * from the handler; the socket opens once the host has sent it. Throws
 * unless the request asks for a WebSocket and the host can hold the
 * connection: Rust's `Instances::max_held_connections` bounds them, and
 * hosts other than the fetchlet App host have none.
 */
export function upgradeWebSocket(
  request: Request,
  options: UpgradeWebSocketOptions = {},
): {
  socket: WebSocket;
  response: Response;
} {
  if (!asksForWebSocket(request)) {
    throw new TypeError("The request does not ask for a WebSocket upgrade");
  }
  const registry = channelRegistry();
  if (!registry) {
    throw new TypeError("This host does not hold WebSocket connections");
  }
  const headers = new runtime.Headers(options.headers);
  const protocol =
    options.protocol === undefined
      ? (headers.get("sec-websocket-protocol") ?? "")
      : domString(options.protocol);
  const url = new runtime.URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const { socket: target, channel } = openSocket(
    (listener) => registry.upgrade(listener),
    registry,
    url.href,
    protocol,
    url.origin,
  );

  headers.delete("sec-websocket-protocol");
  if (protocol !== "") {
    headers.set("sec-websocket-protocol", protocol);
  }
  return {
    socket: target as unknown as WebSocket,
    response: switchingProtocols(channel, headers),
  };
}

/** The 101 response that hands `channel` to the host. */
function switchingProtocols(channel: number, headers: Headers): Response {
  const response = new runtime.Response(null, {
    status: 200,
    headers,
  });
  // A 101 cannot be constructed; the host completes the handshake for it.
  Object.defineProperty(response, "status", {
    value: 101,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(response, UPGRADE, {
    value: channel,
  });
  return response;
}

/**
 * The upgrade response of the WebSocket the current invocation accepted, with
 * `headers`. For framework integrations whose framework copies the handler's
 * response into one of its own, which cannot be constructed with status 101.
 */
export function upgradeResponse(headers?: HeadersInit): Response {
  const channel = channelRegistry()?.accepted();
  if (channel === undefined) {
    throw new TypeError("No WebSocket upgrade was accepted");
  }
  return switchingProtocols(channel, new runtime.Headers(headers));
}

/** The channel of an upgrade response from upgradeWebSocket, if it is one. */
export function upgradeOf(response: Response): number | undefined {
  const channel = (response as unknown as Record<symbol, unknown>)[UPGRADE];
  return typeof channel === "number" ? channel : undefined;
}

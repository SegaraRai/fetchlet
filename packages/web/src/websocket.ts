// Server WebSockets: accept a Fetch request's WebSocket upgrade in the
// fetchlet App host.

export {
  type UpgradeWebSocketOptions,
  upgradeResponse,
  upgradeWebSocket,
} from "./internal/websocket/websocket";

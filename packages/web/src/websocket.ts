// WebSockets of the fetchlet App host: accept a Fetch request's WebSocket
// upgrade. Client connections use the global `WebSocket`.

export {
  upgradeResponse,
  upgradeWebSocket,
  type UpgradeWebSocketOptions,
} from "./internal/websocket/upgrade";

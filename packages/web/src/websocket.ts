// Server WebSockets and channels of the fetchlet App host: accept a Fetch
// request's WebSocket upgrade, and type the channels of env bindings.

export type {
  ChannelBinding,
  ChannelClose,
  ChannelStream,
  HostChannel,
} from "./internal/websocket/channel";
export {
  upgradeResponse,
  upgradeWebSocket,
  type UpgradeWebSocketOptions,
} from "./internal/websocket/websocket";

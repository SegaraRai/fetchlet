// Portable Web API profile shared by framework adapters.

import "@fetchlet/web";

export { wireRequest, wireResponse } from "@fetchlet/web/wire";

export {
  connect,
  getBindings,
  upgradeWebSocket,
  waitUntil,
  type ExecutionContext,
  type ExportedHandler,
  type FetchletBindings,
  type ServiceBinding,
  type Socket,
  type SocketAddress,
  type SocketInfo,
  type SocketOptions,
  type UpgradeWebSocketOptions,
} from "./handler";

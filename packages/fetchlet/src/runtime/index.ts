// Portable Web API profile shared by framework adapters.

import "@fetchlet/web";

export { type UpgradeWebSocketOptions, upgradeWebSocket } from "@fetchlet/web/websocket";
export { wireRequest, wireResponse } from "@fetchlet/web/wire";
export { getBindings, waitUntil } from "./handler";
export type {
  ExecutionContext,
  ExportedHandler,
  FetchletBindings,
  ServiceBinding,
} from "./handler";

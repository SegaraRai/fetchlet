// Portable Web API profile shared by framework adapters.

import "@fetchlet/web";

export { wireRequest, wireResponse } from "@fetchlet/web/wire";
export { getBindings, type UpgradeWebSocketOptions, upgradeWebSocket, waitUntil } from "./handler";
export type {
  ExecutionContext,
  ExportedHandler,
  FetchletBindings,
  ServiceBinding,
} from "./handler";

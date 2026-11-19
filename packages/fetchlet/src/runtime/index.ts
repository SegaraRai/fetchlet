// Portable Web API profile shared by framework adapters.

import "@fetchlet/web";

export { wireRequest, wireResponse } from "@fetchlet/web/wire";
export { getBindings, waitUntil } from "./handler";
export type { ExecutionContext, ExportedHandler, ServiceBinding } from "./handler";

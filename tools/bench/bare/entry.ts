import { createFetchHandler, getBindings } from "fetchlet/runtime/handler";
import { app, type Bindings } from "./app.ts";

export const handle = createFetchHandler(
  (request, context: { clientAddress?: string } | undefined) =>
    app(request, getBindings<Bindings>(), context?.clientAddress),
);

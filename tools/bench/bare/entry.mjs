import { createFetchHandler, getBindings } from "@fetchlet/runtime/handler";
import { app } from "./app.mjs";

export const handle = createFetchHandler((request, context) =>
  app(request, getBindings(), context?.clientAddress),
);

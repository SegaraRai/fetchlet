import { createFetchHandler } from "fetchlet/runtime/handler";

export const handle = createFetchHandler(
  (request) => new Response("packed " + new URL(request.url).pathname),
);

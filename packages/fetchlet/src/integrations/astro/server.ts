import { createFetchHandler, getBindings, waitUntil } from "../../runtime/handler.ts";
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";

interface RequestContext {
  clientAddress?: string;
}

const app = createApp({
  streaming: true,
});

setGetEnv((key) => {
  const value = getBindings<Record<string, unknown>>()[key];
  return typeof value === "string" ? value : undefined;
});

async function render(request: Request, context: RequestContext = {}): Promise<Response> {
  return app.render(request, {
    clientAddress: context.clientAddress,
    locals: {
      env: getBindings(),
      waitUntil,
    },
    addCookieHeader: true,
  });
}

export const handle = createFetchHandler(render);

export default {
  fetch: render,
};

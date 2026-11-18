import type { MiddlewareHandler } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";

import adapter, { type FetchletWakuOptions } from "./adapter.ts";
import { contextKey } from "./symbol.ts";

// Waku's adapter builder passes its handlers to the factory; the RSC
// middleware answers with what the adapter gave Hono.
vi.mock(import("waku/adapter-builders"), () => ({
  unstable_createServerEntryAdapter: ((factory: (handlers: unknown, options: unknown) => unknown) =>
    (handlers: unknown, options: unknown) =>
      factory(handlers, options)) as never,
}));
vi.mock(
  import("waku/internals"),
  () =>
    ({
      unstable_honoMiddleware: {
        middlewareRunner: (() => async (_c: unknown, next: () => Promise<void>) => next()) as never,
        rscMiddleware: (({ processRequest }: { processRequest: MiddlewareHandler }) =>
          processRequest) as never,
      },
    }) as never,
);

interface Entry {
  fetch(request: Request, context?: object): Promise<Response>;
  build: unknown;
  buildOptions: unknown;
  buildEnhancers: string[];
}

function entry(
  processRequest: MiddlewareHandler,
  options?: FetchletWakuOptions,
  notFoundHtml?: string,
): Entry {
  return adapter(
    {
      processRequest,
      processBuild: "build",
      config: {
        distDir: "dist",
      },
      notFoundHtml,
    },
    options,
  ) as Entry;
}

describe("fetchlet/waku adapter", () => {
  test("puts the context on the request and the bindings in Hono's env", async () => {
    const waitUntil = vi.fn();
    const context = {
      clientAddress: "192.0.2.1",
      env: {
        MESSAGE: "hi",
      },
      waitUntil,
    };
    const work = Promise.resolve();
    const response = await entry(async (c) => {
      c.executionCtx.waitUntil(work);
      const request = c.req.raw as Request & { [contextKey]?: unknown };
      return c.json({
        context: request[contextKey] === context,
        env: c.env,
      });
    }).fetch(new Request("https://app.test/"), context);
    expect(await response.json()).toStrictEqual({
      context: true,
      env: {
        MESSAGE: "hi",
      },
    });
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  test("serves a request without a context", async () => {
    const response = await entry(async (c) => c.text("ok")).fetch(new Request("https://app.test/"));
    expect(await response.text()).toBe("ok");
  });

  test("answers Waku's not-found page, or plain text without one", async () => {
    const next = (async (_c, next) => next()) as MiddlewareHandler;
    const html = await entry(next, {}, "<h1>missing</h1>").fetch(new Request("https://app.test/"));
    expect(html.status).toBe(404);
    expect(await html.text()).toBe("<h1>missing</h1>");
    const text = await entry(next).fetch(new Request("https://app.test/"));
    expect(text.status).toBe(404);
    expect(await text.text()).toBe("404 Not Found");
  });

  test("runs the app's Hono middleware before Waku's handler", async () => {
    const order: string[] = [];
    const response = await entry(
      async (c) => {
        order.push("waku");
        return c.text("ok");
      },
      {
        middlewareFns: [
          () => async (_c, next) => {
            order.push("first");
            await next();
          },
          () => async (_c, next) => {
            order.push("second");
            await next();
          },
        ],
      },
    ).fetch(new Request("https://app.test/"));
    expect(await response.text()).toBe("ok");
    expect(order).toStrictEqual(["first", "second", "waku"]);
  });

  test("passes the fetchlet options to the build enhancer", () => {
    const result = entry(async (c) => c.text("ok"), {
      outDir: "out",
      backend: "v8",
      middlewareFns: [],
    });
    expect(result.build).toBe("build");
    expect(result.buildOptions).toStrictEqual({
      distDir: "dist",
      fetchlet: {
        outDir: "out",
        backend: "v8",
      },
    });
    expect(result.buildEnhancers).toStrictEqual(["fetchlet/waku/build-enhancer"]);
  });
});

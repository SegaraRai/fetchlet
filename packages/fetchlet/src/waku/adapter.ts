import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono/tiny";
import { unstable_createServerEntryAdapter as createServerEntryAdapter } from "waku/adapter-builders";
import { unstable_honoMiddleware as honoMiddleware } from "waku/internals";

import type { BuildBackend, IntlOptions } from "../build/index.ts";
import type { FetchletRequestContext } from "./context.ts";
import { contextKey } from "./symbol.ts";

type WakuMiddleware = (options: { app: HonoApp }) => MiddlewareHandler;

export interface FetchletWakuOptions {
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
  /** Hono middleware run before Waku's handler. */
  middlewareFns?: WakuMiddleware[];
  /** Waku middleware modules, as `import.meta.glob` returns them. */
  middlewareModules?: Record<string, () => Promise<{ default: WakuMiddleware }>>;
}

export type { FetchletBindings, FetchletRequestContext, ServiceBinding } from "./context.ts";

const { rscMiddleware, middlewareRunner } = honoMiddleware;

/**
 * The Waku server entry adapter for fetchlet. The Rust server serves the
 * client build and the App's request budget bounds request bodies, so the
 * entry only runs Waku's middleware and RSC handler.
 */
const adapter: (handlers: unknown, options?: FetchletWakuOptions) => unknown =
  createServerEntryAdapter(
    ({ processRequest, processBuild, config, notFoundHtml }, options: FetchletWakuOptions = {}) => {
      const { middlewareFns = [], middlewareModules = {}, ...fetchlet } = options;
      const app = new Hono();
      app.notFound((c) =>
        notFoundHtml ? c.html(notFoundHtml, 404) : c.text("404 Not Found", 404),
      );
      for (const middlewareFn of middlewareFns) {
        app.use(middlewareFn({ app }));
      }
      app.use(middlewareRunner(middlewareModules, { app }));
      app.use(rscMiddleware({ processRequest }));
      return {
        // The fetchlet entry passes the request context as the second argument.
        fetch(request: Request, context?: FetchletRequestContext) {
          if (context) {
            Object.defineProperty(request, contextKey, { value: context, configurable: true });
          }
          return app.fetch(request, context?.env as never, {
            waitUntil: (promise: Promise<unknown>) => context?.waitUntil(promise),
            passThroughOnException() {},
            props: {},
          });
        },
        build: processBuild,
        buildOptions: { distDir: config.distDir, fetchlet },
        buildEnhancers: ["fetchlet/waku/build-enhancer"],
      };
    },
  ) as never;

export default adapter;

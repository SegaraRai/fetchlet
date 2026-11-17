import { Hono } from "hono/tiny";
import { unstable_createServerEntryAdapter as createServerEntryAdapter } from "waku/adapter-builders";
import { unstable_honoMiddleware as honoMiddleware } from "waku/internals";
import { contextKey } from "./symbol.mjs";

const { rscMiddleware, middlewareRunner } = honoMiddleware;

/**
 * The Waku server entry adapter for fetchlet. The Rust server serves the
 * client build and the App's request budget bounds request bodies, so the
 * entry only runs Waku's middleware and RSC handler.
 */
export default createServerEntryAdapter(
  ({ processRequest, processBuild, config, notFoundHtml }, options = {}) => {
    const { middlewareFns = [], middlewareModules = {}, ...fetchlet } = options;
    const app = new Hono();
    app.notFound((c) => (notFoundHtml ? c.html(notFoundHtml, 404) : c.text("404 Not Found", 404)));
    for (const middlewareFn of middlewareFns) {
      app.use(middlewareFn({ app }));
    }
    app.use(middlewareRunner(middlewareModules, { app }));
    app.use(rscMiddleware({ processRequest }));
    return {
      // The fetchlet entry passes the request context as the second argument.
      fetch(request, context) {
        if (context) {
          Object.defineProperty(request, contextKey, { value: context, configurable: true });
        }
        return app.fetch(request, context?.env, {
          waitUntil: (promise) => context?.waitUntil(promise),
          passThroughOnException() {},
          props: {},
        });
      },
      build: processBuild,
      buildOptions: { distDir: config.distDir, fetchlet },
      buildEnhancers: ["fetchlet/waku/build-enhancer"],
    };
  },
);

import type { MiddlewareHandler, Hono } from "hono";

export interface FetchletWakuOptions {
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: "portable" | "quickjs" | "boa" | "v8";
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: {
    locales?: string[];
    timeZoneData?: "utc" | "golden" | "all";
    apis?: string[];
  };
  /** Hono middleware run before Waku's handler. */
  middlewareFns?: ((options: { app: Hono }) => MiddlewareHandler)[];
  /** Waku middleware modules, as `import.meta.glob` returns them. */
  middlewareModules?: Record<string, () => Promise<unknown>>;
}

export type { FetchletBindings, FetchletRequestContext, ServiceBinding } from "./context";

/** Wrap Waku's handlers, such as `fsRouter(...)`, as a fetchlet server entry. */
declare const adapter: (handlers: unknown, options?: FetchletWakuOptions) => unknown;
export default adapter;

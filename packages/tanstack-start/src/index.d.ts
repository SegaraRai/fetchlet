import type { Plugin } from "vite";

export interface FetchletStartOptions {
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: "portable" | "quickjs" | "boa" | "v8";
  /** Intl data for engines without native Intl, as in @fetchlet/build. */
  intl?: {
    locales?: string[];
    timeZoneData?: "utc" | "golden" | "all";
    apis?: string[];
  };
}

/** The request context the fetchlet entry passes to TanStack Start. */
export interface FetchletRequestContext<Env = Readonly<Record<string, unknown>>> {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Env;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

/** Build TanStack Start's server environment into a fetchlet artifact. */
export default function fetchletStart(options?: FetchletStartOptions): Plugin;

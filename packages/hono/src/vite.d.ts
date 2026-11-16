import type { Plugin } from "vite";

export interface FetchletBuildOptions {
  /** The app modules, as in @hono/vite-build. */
  entry?: string | string[];
  /** Where server.js and fetchlet.json are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: "portable" | "quickjs" | "boa" | "v8";
  /** Intl data for engines without native Intl, as in @fetchlet/build. */
  intl?: {
    locales?: string[];
    timeZoneData?: "utc" | "golden" | "all";
    apis?: string[];
  };
  /** Modules kept out of the server bundle. */
  external?: string[];
}

/** Build a Hono app into a fetchlet artifact. */
export default function fetchletBuild(options?: FetchletBuildOptions): Plugin;

import type { Plugin } from "vite";

export interface FetchletVinextOptions {
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

export type { FetchletBindings, FetchletRequestContext, ServiceBinding } from "./context";

/** Build the vinext App Router server into a fetchlet artifact. */
export default function fetchletVinext(options?: FetchletVinextOptions): Plugin;

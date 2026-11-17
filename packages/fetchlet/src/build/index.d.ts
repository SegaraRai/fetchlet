import type { Plugin } from "vite-plus";

import type { BuildBackend, IntlOptions } from "./polyfills/plan.js";

export type { BuildBackend, IntlOptions };

export interface BuildArtifactOptions {
  /** The framework's server entry, which exports `handle` and any functions. */
  entry: string;
  /** The artifact directory; `server.js` and `fetchlet.json` are written here. */
  outDir: string;
  plugins?: Plugin[];
  /** Recorded in fetchlet.json. */
  framework?: string;
  /** The framework's rendering profile, recorded in fetchlet.json. */
  rendering?: string;
  /** APIs the application requires beyond the portable profile. */
  requirements?: string[];
  backend?: BuildBackend;
  intl?: IntlOptions;
  /** `"serialized"` provides `node:async_hooks` with one context at a time. */
  asyncContext?: "serialized";
  /** Extra resolve conditions for dependencies a framework left external. */
  conditions?: string[];
}

/** Initialize the Web API profile before evaluating framework modules. */
export function buildArtifact(options: BuildArtifactOptions): Promise<void>;

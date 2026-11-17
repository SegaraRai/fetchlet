import type { AstroIntegration } from "astro";

import type { BuildBackend, IntlOptions } from "../build/index.js";

export interface FetchletAstroOptions {
  /** The artifact directory. Defaults to "build". */
  out?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl. */
  intl?: IntlOptions;
}

/** The Astro adapter that builds the server output into a fetchlet artifact. */
export default function fetchletAdapter(options?: FetchletAstroOptions): AstroIntegration;

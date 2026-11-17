import type { Adapter } from "@sveltejs/kit";

import type { BuildBackend, IntlOptions } from "../build/index.js";

export interface FetchletSvelteKitOptions {
  /** The artifact directory. Defaults to "build". */
  out?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl. */
  intl?: IntlOptions;
  /**
   * "async" supports Svelte's asynchronous server rendering and remote
   * functions: `getRequestEvent()` keeps the current request across awaits
   * within one invocation. Defaults to "synchronous".
   */
  rendering?: "synchronous" | "async";
}

/** The SvelteKit adapter that builds the server into a fetchlet artifact. */
export default function fetchletAdapter(options?: FetchletSvelteKitOptions): Adapter;

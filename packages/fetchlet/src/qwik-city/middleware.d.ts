import type { ServerRenderOptions } from "@builder.io/qwik-city/middleware/request-handler";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
export interface FetchletBindings {}

/** What `platform` holds in Qwik City request events. */
export interface FetchletPlatform {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Readonly<FetchletBindings>;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

declare module "@builder.io/qwik-city" {
  interface QwikCityPlatform extends FetchletPlatform {}
}

export interface QwikCityFetchletOptions extends ServerRenderOptions {}

/** The Fetch handler of the fetchlet entry. */
export type QwikCityFetchletHandler = (
  request: Request,
  context?: { clientAddress?: string },
) => Promise<Response>;

/** Create the Fetch handler for `src/entry.fetchlet.tsx`. */
export function createQwikCity(options: QwikCityFetchletOptions): QwikCityFetchletHandler;

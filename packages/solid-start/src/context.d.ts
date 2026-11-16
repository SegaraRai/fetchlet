import type { FetchEvent } from "@solidjs/start/server";

/** Bindings of the fetchlet App. Augment this interface to type them. */
export interface FetchletBindings {}

/** The request context the fetchlet entry passes to SolidStart. */
export interface FetchletRequestContext {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Readonly<FetchletBindings>;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

/**
 * The fetchlet request context of the current request, or of `event`.
 * Throws outside a server request.
 */
export function getRequestContext(event?: FetchEvent): FetchletRequestContext;

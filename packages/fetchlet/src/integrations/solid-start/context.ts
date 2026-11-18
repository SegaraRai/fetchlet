import type { FetchEvent } from "@solidjs/start/server";
import { getRequestEvent } from "solid-js/web";

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
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
export function getRequestContext(
  event: FetchEvent | undefined = getRequestEvent(),
): FetchletRequestContext {
  const runtime = event?.nativeEvent?.runtime as { fetchlet?: FetchletRequestContext } | undefined;
  const context = runtime?.fetchlet;
  if (!context) {
    throw new Error("getRequestContext() runs on the server inside a fetchlet request");
  }
  return context;
}

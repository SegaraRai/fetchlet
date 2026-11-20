import type { FetchEvent } from "@solidjs/start/server";
import type { FetchletBindings as Bindings } from "fetchlet/bindings";
import { getRequestEvent } from "solid-js/web";

/**
 * The fixed host bindings of the fetchlet App: the keys applications declare
 * on `FetchletBindings` of fetchlet/bindings.
 */
export interface FetchletBindings extends Bindings {}

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

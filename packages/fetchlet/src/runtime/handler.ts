import { wireRequest, wireResponse, type WireRequest, type WireResponse } from "@fetchlet/web/wire";
import type { FetchletBindings, ServiceBinding } from "fetchlet/bindings";

export type { FetchletBindings, ServiceBinding };

/**
 * The third argument of `fetch` in a module with the Workers module shape,
 * as `exportedHandler` in fetchlet/build and fetchlet/vite call it.
 */
export interface ExecutionContext {
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
  /** Present for Workers compatibility; fetchlet has no origin to fall back to. */
  passThroughOnException(): void;
  /** Present for Workers compatibility; always empty. */
  props: Record<string, unknown>;
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
}

/** A server module's default export in the Workers module shape. */
export interface ExportedHandler<Env = FetchletBindings> {
  fetch(request: Request, env: Readonly<Env>, ctx: ExecutionContext): Response | Promise<Response>;
}

interface FetchletHost<Bindings> {
  env: Readonly<Bindings>;
  waitUntil(promise: unknown): void;
}

function host<Bindings>(): FetchletHost<Bindings> {
  const fetchlet = (
    globalThis as typeof globalThis & {
      fetchlet?: FetchletHost<Bindings>;
    }
  ).fetchlet;
  if (!fetchlet) {
    throw new Error("Rust host bindings are required");
  }
  return fetchlet;
}

/** The host bindings, typed by default with the keys declared on fetchlet/bindings. */
export function getBindings<Bindings extends object = FetchletBindings>(): Readonly<Bindings> {
  return host<Bindings>().env;
}

/**
 * Keep the current invocation open until `promise` settles, after its
 * response. The Rust host bounds the work with `Limits::background_timeout`
 * and `Limits::background_tasks`; a rejection does not change the response.
 */
export function waitUntil(promise: unknown): void {
  host().waitUntil(promise);
}

export function createFetchHandler<Context>(
  handler: (request: Request, context: Context) => Response | Promise<Response>,
) {
  return async (input: WireRequest, context: Context): Promise<WireResponse> => {
    const response = await handler(wireRequest(input), context);
    return wireResponse(response);
  };
}

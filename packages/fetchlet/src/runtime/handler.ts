import { wireRequest, wireResponse, type WireRequest, type WireResponse } from "./web/wire";

export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
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

export function getBindings<Bindings extends object>(): Readonly<Bindings> {
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

import { wireRequest, wireResponse, type WireRequest, type WireResponse } from "./web/wire";

export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function getBindings<Bindings extends object>(): Readonly<Bindings> {
  const host = globalThis as typeof globalThis & {
    fetchlet?: {
      env: Readonly<Bindings>;
    };
  };
  if (!host.fetchlet) {
    throw new Error("Rust host bindings are required");
  }
  return host.fetchlet.env;
}

export function createFetchHandler<Context>(
  handler: (request: Request, context: Context) => Response | Promise<Response>,
) {
  return async (input: WireRequest, context: Context): Promise<WireResponse> => {
    const response = await handler(wireRequest(input), context);
    return wireResponse(response);
  };
}

import { runtime } from "./runtime";

export interface WireRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: number[] | null;
}

export interface WireResponse {
  status: number;
  headers: Array<[string, string]>;
  /** The complete body, or the bytes already available when `stream` is set. */
  body: number[];
  /** A body left open for the Rust host to pull. */
  stream?: number;
}

/** Response body registry installed by the fetchlet Rust host. */
interface ResponseBodyRegistry {
  streaming(): boolean;
  register(stream: ReadableStream<Uint8Array>): number;
  pull(id: number, waitForData: boolean): Promise<{ chunk: number[]; done: boolean }>;
}

function responseBodyRegistry(): ResponseBodyRegistry | undefined {
  const registry = runtime.__fetchletResponseBodies as ResponseBodyRegistry | undefined;
  return registry?.streaming() ? registry : undefined;
}

export function wireRequest(input: WireRequest): Request {
  return new runtime.Request(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body === null || input.body === undefined ? undefined : new Uint8Array(input.body),
  });
}
export async function wireResponse(response: Response): Promise<WireResponse> {
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value: string, key: string) => {
    if (key !== "set-cookie") {
      headers.push([key, value]);
    }
  });
  for (const value of response.headers.getSetCookie()) {
    headers.push(["set-cookie", value]);
  }

  const registry = responseBodyRegistry();
  if (registry && response.body !== null) {
    if (response.bodyUsed || response.body.locked) {
      throw new TypeError("Response body is already used");
    }
    // Send the head with the bytes available now; the host pulls the rest.
    const id = registry.register(response.body);
    const initial = await registry.pull(id, false);
    return {
      status: response.status,
      headers,
      body: initial.chunk,
      ...(initial.done ? {} : { stream: id }),
    };
  }

  return {
    status: response.status,
    headers,
    body: Array.from(new Uint8Array(await response.arrayBuffer())),
  };
}

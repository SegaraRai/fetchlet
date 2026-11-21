import { runtime } from "../runtime/runtime";
import { BodyImpl } from "./body";

export interface WireRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  /**
   * Bytes as a Uint8Array from the fetchlet App host, or a number array from
   * `FetchApp`. The App host passes a body that is still arriving as a stream.
   */
  body: ReadableStream<Uint8Array> | Uint8Array | number[] | null;
  /**
   * Aborted by the fetchlet App host when the client goes away. Hosts that
   * pass JSON, such as `FetchApp`, give none, and the request's signal never
   * aborts.
   */
  signal?: AbortSignal;
}

export interface WireResponse {
  status: number;
  headers: Array<[string, string]>;
  /** The complete body, or the bytes already available when `stream` is set. */
  body: Uint8Array | number[];
  /** A body left open for the Rust host to pull. */
  stream?: number;
}

/** Response body registry installed by the fetchlet Rust host. */
interface ResponseBodyRegistry {
  streaming(): boolean;
  register(stream: ReadableStream<Uint8Array>): number;
  pull(
    id: number,
    waitForData: boolean,
  ): Promise<{
    chunk: Uint8Array;
    done: boolean;
  }>;
}

function responseBodyRegistry(): ResponseBodyRegistry | undefined {
  const registry = runtime.__fetchletResponseBodies as ResponseBodyRegistry | undefined;
  return registry?.streaming() ? registry : undefined;
}

export function wireRequest(input: WireRequest): Request {
  const body = input.body;
  if (body instanceof runtime.ReadableStream) {
    return new runtime.Request(input.url, {
      method: input.method,
      headers: input.headers,
      body,
      duplex: "half",
      signal: input.signal,
    } as RequestInit);
  }
  return new runtime.Request(input.url, {
    method: input.method,
    headers: input.headers,
    body:
      body === null || body === undefined
        ? undefined
        : body instanceof Uint8Array
          ? body
          : new Uint8Array(body as number[]),
    signal: input.signal,
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
  // A body this profile still holds as bytes needs no stream or pull.
  const buffered = BodyImpl.takeBytesOf(response);
  if (buffered !== undefined) {
    return {
      status: response.status,
      headers,
      body: registry ? buffered : Array.from(buffered),
    };
  }
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
    // The App host takes typed arrays through its byte store; other hosts take JSON arrays.
    body: registry
      ? new Uint8Array(await response.arrayBuffer())
      : Array.from(new Uint8Array(await response.arrayBuffer())),
  };
}

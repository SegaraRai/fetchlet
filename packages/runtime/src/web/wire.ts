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
  body: number[];
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

  return {
    status: response.status,
    headers,
    body: Array.from(new Uint8Array(await response.arrayBuffer())),
  };
}

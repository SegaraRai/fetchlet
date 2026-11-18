import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { wireRequest, wireResponse } from "./wire.ts";

type Global = typeof globalThis & { __fetchletResponseBodies?: unknown };

/** A response body registry like the Rust host's, over in-memory streams. */
function registry({ streaming = true } = {}) {
  const streams: ReadableStream<Uint8Array>[] = [];
  const fake = {
    streaming: () => streaming,
    register: vi.fn((stream: ReadableStream<Uint8Array>) => streams.push(stream) - 1),
    pull: vi.fn(async (id: number) => {
      const { value, done } = await streams[id]!.getReader().read();
      return {
        chunk: value ?? new Uint8Array(),
        done,
      };
    }),
  };
  (globalThis as Global).__fetchletResponseBodies = fake;
  return fake;
}

afterEach(() => {
  delete (globalThis as Global).__fetchletResponseBodies;
});

const bytes = (text: string) => new TextEncoder().encode(text);

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(bytes(chunk));
      }
      controller.close();
    },
  });
}

describe("wireRequest", () => {
  test("accepts bytes, a number array or no body", async () => {
    const base = {
      url: "https://app.test/",
      method: "POST",
      headers: [["content-type", "text/plain"]] as [string, string][],
    };
    expect(await wireRequest({ ...base, body: bytes("typed") }).text()).toBe("typed");
    expect(await wireRequest({ ...base, body: [104, 105] }).text()).toBe("hi");
    const empty = wireRequest({ ...base, method: "GET", body: null });
    expect(empty.body).toBeNull();
    expect(empty.headers.get("content-type")).toBe("text/plain");
  });

  test("passes a body that is still arriving as a stream", async () => {
    const request = wireRequest({
      url: "https://app.test/upload",
      method: "PUT",
      headers: [],
      body: stream(["a", "b"]),
    });
    expect(await request.text()).toBe("ab");
  });
});

describe("wireResponse", () => {
  test("without the registry, the body is a number array", async () => {
    const response = await wireResponse(new Response("hi", { status: 202 }));
    expect(response).toStrictEqual({
      status: 202,
      headers: [["content-type", "text/plain;charset=UTF-8"]],
      body: [104, 105],
    });
  });

  test("a registry that does not stream also gets a number array", async () => {
    const fake = registry({ streaming: false });
    const response = await wireResponse(new Response(stream(["a", "b"])));
    expect(response.body).toStrictEqual([97, 98]);
    expect(fake.register).not.toHaveBeenCalled();
  });

  test("with the registry, a stream is sent with its first chunk and left open", async () => {
    const fake = registry();
    const response = await wireResponse(new Response(stream(["first", "second"])));
    expect(response.body).toStrictEqual(bytes("first"));
    expect(response.stream).toBe(0);
    expect(fake.pull).toHaveBeenCalledWith(0, false);
  });

  test("a stream that ends in the first pull is not left open", async () => {
    registry();
    const response = await wireResponse(new Response(stream([])));
    expect(response.body).toStrictEqual(new Uint8Array());
    expect(response).not.toHaveProperty("stream");
  });

  test("a response without a body sends empty bytes", async () => {
    registry();
    const response = await wireResponse(new Response(null, { status: 204 }));
    expect(response).toStrictEqual({
      status: 204,
      headers: [],
      body: new Uint8Array(),
    });
  });

  test("a body that was already read is refused", async () => {
    registry();
    const response = new Response(stream(["x"]));
    await response.text();
    await expect(wireResponse(response)).rejects.toThrow("Response body is already used");
  });

  test("Set-Cookie values stay separate and come after the other headers", async () => {
    const headers = new Headers({
      "x-a": "1",
    });
    headers.append("set-cookie", "a=1, b");
    headers.append("set-cookie", "c=2");
    const response = await wireResponse(new Response(null, { headers }));
    expect(response.headers).toStrictEqual([
      ["x-a", "1"],
      ["set-cookie", "a=1, b"],
      ["set-cookie", "c=2"],
    ]);
  });
});

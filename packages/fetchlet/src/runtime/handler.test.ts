import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createFetchHandler, getBindings, waitUntil } from "./handler.ts";

type Global = typeof globalThis & { fetchlet?: unknown };

afterEach(() => {
  delete (globalThis as Global).fetchlet;
});

describe("createFetchHandler", () => {
  test("passes the wire request as a Request, with the context", async () => {
    const seen: unknown[] = [];
    const handle = createFetchHandler(async (request: Request, context: { name: string }) => {
      seen.push(request.method, request.url, request.headers.get("x-test"), await request.text());
      seen.push(context.name);
      return new Response("ok");
    });
    await handle(
      {
        url: "https://app.test/path?q=1",
        method: "POST",
        headers: [["x-test", "yes"]],
        body: new TextEncoder().encode("body"),
      },
      {
        name: "context",
      },
    );
    expect(seen).toStrictEqual(["POST", "https://app.test/path?q=1", "yes", "body", "context"]);
  });

  test("accepts a body as a number array, as FetchApp sends it", async () => {
    const handle = createFetchHandler(
      async (request: Request) => new Response(await request.text()),
    );
    const response = await handle(
      {
        url: "https://app.test/",
        method: "PUT",
        headers: [],
        body: [104, 105],
      },
      undefined,
    );
    expect(response.body).toStrictEqual([104, 105]);
  });

  test("returns the status, headers and body as wire values", async () => {
    const handle = createFetchHandler(
      () =>
        new Response("hello", {
          status: 201,
          headers: {
            "content-type": "text/plain",
            "x-one": "1",
          },
        }),
    );
    const response = await handle(
      {
        url: "https://app.test/",
        method: "GET",
        headers: [],
        body: null,
      },
      undefined,
    );
    expect(response.status).toBe(201);
    expect(response.headers).toContainEqual(["content-type", "text/plain"]);
    expect(response.headers).toContainEqual(["x-one", "1"]);
    expect(response.body).toStrictEqual([...new TextEncoder().encode("hello")]);
    expect(response.stream).toBeUndefined();
  });

  test("keeps each Set-Cookie value as its own header", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2, c=3");
    const handle = createFetchHandler(() => new Response(null, { headers }));
    const response = await handle(
      {
        url: "https://app.test/",
        method: "GET",
        headers: [],
        body: null,
      },
      undefined,
    );
    expect(response.headers.filter(([name]) => name === "set-cookie")).toStrictEqual([
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2, c=3"],
    ]);
  });

  test("a handler that throws rejects the invocation", async () => {
    const handle = createFetchHandler(() => {
      throw new Error("handler failed");
    });
    await expect(
      handle(
        {
          url: "https://app.test/",
          method: "GET",
          headers: [],
          body: null,
        },
        undefined,
      ),
    ).rejects.toThrow("handler failed");
  });

  test("an invalid wire request fails before the handler runs", async () => {
    const handler = vi.fn(() => new Response());
    const handle = createFetchHandler(handler);
    await expect(
      handle(
        {
          url: "not a url",
          method: "GET",
          headers: [],
          body: null,
        },
        undefined,
      ),
    ).rejects.toThrow(TypeError);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("host bindings", () => {
  test("getBindings and waitUntil require the Rust host", () => {
    expect(() => getBindings()).toThrow("Rust host bindings are required");
    expect(() => waitUntil(Promise.resolve())).toThrow("Rust host bindings are required");
  });

  test("getBindings returns the host's env and waitUntil forwards the promise", () => {
    const env = Object.freeze({
      MESSAGE: "hi",
    });
    const registered: unknown[] = [];
    (globalThis as Global).fetchlet = {
      env,
      waitUntil: (promise: unknown) => registered.push(promise),
    };
    expect(getBindings<{ MESSAGE: string }>()).toBe(env);
    const work = Promise.resolve();
    waitUntil(work);
    expect(registered).toStrictEqual([work]);
  });
});

import {
  requestHandler,
  type ServerRequestEvent,
} from "@builder.io/qwik-city/middleware/request-handler";
import { setServerPlatform } from "@builder.io/qwik/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createQwikCity } from "./middleware.ts";

// The adapter entry also installs the Web API profile, which Node does not need.
vi.mock(import("fetchlet/runtime/adapter"), () => import("../../runtime/handler.ts"));
vi.mock(import("@builder.io/qwik/server"), () => ({
  setServerPlatform: vi.fn(),
}));
vi.mock(import("@builder.io/qwik-city/middleware/request-handler"), async (original) => ({
  ...(await original()),
  requestHandler: vi.fn(),
}));

type Global = typeof globalThis & { fetchlet?: unknown };
const registered: unknown[] = [];

beforeEach(() => {
  registered.length = 0;
  (globalThis as Global).fetchlet = {
    env: {
      MESSAGE: "hi",
      SERVICE: {
        fetch() {},
      },
    },
    waitUntil: (promise: unknown) => registered.push(promise),
  };
  vi.mocked(requestHandler).mockReset();
  vi.mocked(setServerPlatform).mockClear();
});
afterEach(() => {
  delete (globalThis as Global).fetchlet;
});

/** Run the handler and return the request event Qwik City received. */
async function serve(
  handled: (event: ServerRequestEvent<Response>) => unknown,
  context?: { clientAddress?: string },
) {
  let event: ServerRequestEvent<Response> | undefined;
  vi.mocked(requestHandler).mockImplementation(async (serverRequestEv) => {
    event = serverRequestEv as ServerRequestEvent<Response>;
    return handled(event) as never;
  });
  const handle = createQwikCity({
    render: vi.fn() as never,
    qwikCityPlan: {} as never,
  });
  const response = await handle(new Request("https://app.test/page?q=1"), context);
  return { event: event!, response };
}

describe("createQwikCity", () => {
  test("sets the server platform only with a manifest", () => {
    createQwikCity({
      render: vi.fn() as never,
      qwikCityPlan: {} as never,
    });
    expect(setServerPlatform).not.toHaveBeenCalled();
    const manifest = {
      manifestHash: "abc",
    };
    createQwikCity({
      render: vi.fn() as never,
      qwikCityPlan: {} as never,
      manifest: manifest as never,
    });
    expect(setServerPlatform).toHaveBeenCalledWith(manifest);
  });

  test("passes the request, string env values and the platform", async () => {
    const { event } = await serve(() => null, {
      clientAddress: "192.0.2.1",
    });
    expect(event.mode).toBe("server");
    expect(event.url.href).toBe("https://app.test/page?q=1");
    expect(event.env.get("MESSAGE")).toBe("hi");
    expect(event.env.get("SERVICE")).toBeUndefined();
    expect(event.env.get("MISSING")).toBeUndefined();
    expect(event.platform).toMatchObject({
      clientAddress: "192.0.2.1",
      env: {
        MESSAGE: "hi",
      },
    });
    expect(event.getClientConn()).toStrictEqual({
      ip: "192.0.2.1",
    });
    const work = Promise.resolve();
    (event.platform as { waitUntil(promise: unknown): void }).waitUntil(work);
    expect(registered).toStrictEqual([work]);
  });

  test("streams the response Qwik City writes, with its headers and cookies", async () => {
    const { response } = await serve((event) => {
      let resolve!: (response: Response) => void;
      const response = new Promise<Response>((done) => (resolve = done));
      const cookies = {
        headers: () => ["session=1; Path=/"],
      };
      const writable = event.getWritableStream(
        201,
        new Headers({
          "content-type": "text/html",
        }),
        cookies as never,
        resolve,
        {} as never,
      );
      const writer = writable.getWriter();
      void writer.write(new TextEncoder().encode("<p>page</p>")).then(() => writer.close());
      return {
        response,
        completion: Promise.resolve(undefined),
        requestEv: {},
      };
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.getSetCookie()).toStrictEqual(["session=1; Path=/"]);
    expect(await response.text()).toBe("<p>page</p>");
  });

  test("answers 404 when no route handles the request", async () => {
    for (const handled of [
      () => null,
      () => ({
        response: Promise.resolve(undefined),
        completion: Promise.resolve(undefined),
      }),
    ]) {
      const { response } = await serve(handled);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("Not Found");
    }
  });

  test("logs an error that completes the request after the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("render failed");
    await serve(() => ({
      response: Promise.resolve(new Response("partial")),
      completion: Promise.resolve(error),
    }));
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith(error);
    log.mockRestore();
  });
});

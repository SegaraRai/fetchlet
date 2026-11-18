import { describe, expect, test, vi } from "vite-plus/test";
import { getRequest } from "waku/router/server";

import { getRequestContext } from "./context.ts";
import { contextKey } from "./symbol.ts";

// Waku's server module needs the react-server condition; the test supplies the request.
vi.mock(import("waku/router/server"), () => ({
  getRequest: vi.fn(),
}));

describe("waku getRequestContext", () => {
  test("reads the context the adapter set on the request", () => {
    const context = {
      clientAddress: "192.0.2.1",
      env: {},
      waitUntil() {},
    };
    const request = new Request("https://app.test/");
    Object.defineProperty(request, contextKey, {
      value: context,
    });
    expect(getRequestContext(request)).toBe(context);
    vi.mocked(getRequest).mockReturnValue(request);
    expect(getRequestContext()).toBe(context);
  });

  test("throws for a request the adapter did not receive", () => {
    expect(() => getRequestContext(new Request("https://app.test/"))).toThrow(
      /inside a fetchlet request/,
    );
  });

  test("the key is shared through the global symbol registry", () => {
    expect(contextKey).toBe(Symbol.for("fetchlet.waku.context"));
  });
});

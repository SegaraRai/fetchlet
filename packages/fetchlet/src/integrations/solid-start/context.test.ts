import type { FetchEvent } from "@solidjs/start/server";
import { describe, expect, test } from "vite-plus/test";

import { getRequestContext } from "./context.ts";

const event = (runtime: unknown) =>
  ({
    nativeEvent: {
      runtime,
    },
  }) as unknown as FetchEvent;

describe("solid-start getRequestContext", () => {
  test("reads the context the entry set on the request runtime", () => {
    const context = {
      clientAddress: "192.0.2.1",
      env: {},
      waitUntil() {},
    };
    expect(
      getRequestContext(
        event({
          name: "fetchlet",
          fetchlet: context,
        }),
      ),
    ).toBe(context);
  });

  test("throws outside a fetchlet request", () => {
    expect(() => getRequestContext()).toThrow(/inside a fetchlet request/);
    expect(() => getRequestContext(event({ name: "node" }))).toThrow(/inside a fetchlet request/);
  });
});

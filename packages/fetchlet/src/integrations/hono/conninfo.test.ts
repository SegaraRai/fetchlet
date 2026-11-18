import type { Context } from "hono";
import { describe, expect, test } from "vite-plus/test";

import { getConnInfo, getRequestContext } from "./conninfo.ts";

const contextKey = Symbol.for("fetchlet.hono.context");
const honoContext = (env: unknown) => ({ env }) as unknown as Context;

describe("getRequestContext", () => {
  test("reads the Rust request context from the entry's env", () => {
    const context = { clientAddress: "192.0.2.1" };
    expect(getRequestContext(honoContext({ [contextKey]: context }))).toBe(context);
  });

  test("is empty outside the fetchlet entry", () => {
    expect(getRequestContext(honoContext(undefined))).toStrictEqual({});
    expect(getRequestContext(honoContext({ OTHER: "binding" }))).toStrictEqual({});
  });
});

describe("getConnInfo", () => {
  test.each([
    ["192.0.2.1", "IPv4"],
    ["2001:db8::1", "IPv6"],
  ])("%s is %s", (address, addressType) => {
    expect(
      getConnInfo(
        honoContext({
          [contextKey]: {
            clientAddress: address,
          },
        }),
      ),
    ).toStrictEqual({
      remote: {
        address,
        addressType,
      },
    });
  });

  test("leaves the address and its type undefined without one", () => {
    expect(getConnInfo(honoContext({}))).toStrictEqual({
      remote: {
        address: undefined,
        addressType: undefined,
      },
    });
  });
});

import { describe, expect, test } from "vite-plus/test";

import {
  getRequestContext,
  runWithRequestContext,
  type FetchletRequestContext,
} from "./context.ts";

const context = (clientAddress: string): FetchletRequestContext => ({
  clientAddress,
  env: {},
  waitUntil() {},
});

// A query makes Vite load a second instance of the module.
const copySpecifier = "./context.ts?copy";

describe("vinext request context", () => {
  test("throws outside a request", () => {
    expect(() => getRequestContext()).toThrow(/inside a fetchlet request/);
  });

  test("follows the request across awaits, and concurrent requests stay apart", async () => {
    const read = async (name: string) =>
      runWithRequestContext(context(name), async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getRequestContext().clientAddress;
      });
    expect(await Promise.all([read("a"), read("b")])).toStrictEqual(["a", "b"]);
    expect(() => getRequestContext()).toThrow();
  });

  test("every copy of the module shares one store", async () => {
    const copy = (await import(/* @vite-ignore */ copySpecifier)) as typeof import("./context.ts");
    const value = context("shared");
    expect(runWithRequestContext(value, () => copy.getRequestContext())).toBe(value);
  });
});

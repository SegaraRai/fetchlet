import { RouterContextProvider } from "react-router";
import { describe, expect, test } from "vite-plus/test";

import { fetchletContext, getLoadContext } from "./context.ts";

// A query makes Vite load a second instance of the module.
const copySpecifier = "./context.ts?copy";

describe("fetchletContext", () => {
  test("getLoadContext reads what the entry set on the provider", () => {
    const provider = new RouterContextProvider();
    const value = {
      clientAddress: "192.0.2.1",
      env: {
        KEY: "value",
      },
      waitUntil() {},
    };
    provider.set(fetchletContext, value);
    expect(getLoadContext<{ KEY: string }>(provider)).toBe(value);
  });

  test("every copy of the module shares one context key", async () => {
    const copy = (await import(/* @vite-ignore */ copySpecifier)) as typeof import("./context.ts");
    expect(copy.fetchletContext).toBe(fetchletContext);
  });
});

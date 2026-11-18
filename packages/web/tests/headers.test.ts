import { describe, expect, test, vi } from "vite-plus/test";

import { makeHeadersImmutable } from "../src/internal/fetch/headers.ts";
import "../src/internal/fetch/headers.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () =>
  (await import("./isolated-runtime.ts")).isolatedRuntime(["Headers"]),
);

const Headers: typeof globalThis.Headers = runtime.Headers;

describe("the profile's Headers", () => {
  test("is the profile's class, not Node's", () => {
    expect(Headers).not.toBe(globalThis.Headers);
    expect(Headers.name).toBe("Headers");
  });

  test("accepts pairs, records and other Headers", () => {
    const fromPairs = new Headers([
      ["A", "1"],
      ["b", "2"],
    ]);
    expect([...fromPairs]).toStrictEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect([...new Headers({ "X-One": "1" })]).toStrictEqual([["x-one", "1"]]);
    expect([...new Headers(fromPairs)]).toStrictEqual([...fromPairs]);
  });

  test("rejects malformed initializers", () => {
    expect(() => new Headers([["only-name"]] as never)).toThrow(TypeError);
    expect(() => new Headers("a: b" as never)).toThrow("Expected HeadersInit");
    expect(() => new Headers([["bad name", "x"]])).toThrow(TypeError);
    expect(() => new Headers([["a", "line\nbreak"]])).toThrow(TypeError);
    expect(() => new Headers([["a", "Ā"]])).toThrow("Expected a ByteString");
  });

  test("combines values, trims whitespace and sorts on iteration", () => {
    const headers = new Headers();
    headers.append("Accept", " text/html ");
    headers.append("accept", "application/json");
    headers.append("b", "\tvalue\t");
    expect(headers.get("ACCEPT")).toBe("text/html, application/json");
    expect(headers.get("b")).toBe("value");
    expect([...headers.keys()]).toStrictEqual(["accept", "b"]);
    expect(headers.get("missing")).toBeNull();
    expect(headers.has("Accept")).toBe(true);
  });

  test("keeps every Set-Cookie value separate", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    headers.append("set-cookie", "b=2");
    expect(headers.getSetCookie()).toStrictEqual([
      "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "b=2",
    ]);
    expect([...headers]).toStrictEqual([
      ["set-cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT"],
      ["set-cookie", "b=2"],
    ]);
    expect(headers.get("set-cookie")).toBe("a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2");
  });

  test("set replaces every value of the name in place, delete removes them", () => {
    const headers = new Headers([
      ["a", "1"],
      ["b", "2"],
      ["a", "3"],
    ]);
    headers.set("A", "4");
    expect([...headers]).toStrictEqual([
      ["a", "4"],
      ["b", "2"],
    ]);
    headers.delete("a");
    expect([...headers]).toStrictEqual([["b", "2"]]);
  });

  test("iterators see changes made while iterating", () => {
    const headers = new Headers([
      ["a", "1"],
      ["c", "3"],
    ]);
    const seen: string[] = [];
    for (const [name] of headers) {
      seen.push(name);
      if (name === "a") {
        headers.append("b", "2");
      }
    }
    expect(seen).toStrictEqual(["a", "b", "c"]);
  });

  test("forEach passes value, name and the headers", () => {
    const headers = new Headers({ a: "1" });
    const calls: unknown[] = [];
    headers.forEach(function (this: unknown, value, name, object) {
      calls.push([this, value, name, object === headers]);
    }, "this");
    expect(calls).toStrictEqual([["this", "1", "a", true]]);
  });

  test("immutable headers refuse every change", () => {
    const headers = new Headers({ a: "1" });
    makeHeadersImmutable(headers);
    expect(() => headers.append("b", "2")).toThrow("Headers are immutable");
    expect(() => headers.set("a", "2")).toThrow("Headers are immutable");
    expect(() => headers.delete("a")).toThrow(TypeError);
    expect(headers.get("a")).toBe("1");
  });

  test("operations require their arguments", () => {
    const headers = new Headers();
    expect(() => (headers.set as (...args: unknown[]) => void)("a")).toThrow(
      "set requires a name and value",
    );
    expect(() => (headers.get as () => void)()).toThrow(TypeError);
  });
});

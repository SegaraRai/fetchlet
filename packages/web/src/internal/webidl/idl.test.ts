import { describe, expect, test } from "vite-plus/test";

import {
  byteString,
  clampedLongLong,
  dictionary,
  domString,
  exposeAttributes,
  unsignedShort,
  usvString,
} from "./idl.ts";

describe("Web IDL conversions", () => {
  test("domString converts like String but rejects symbols", () => {
    expect(domString(1)).toBe("1");
    expect(domString(null)).toBe("null");
    expect(() => domString(Symbol("x"))).toThrow(TypeError);
  });

  test("byteString rejects characters above U+00FF", () => {
    expect(byteString("café")).toBe("café");
    expect(() => byteString("Ā")).toThrow("Expected a ByteString");
  });

  test("usvString replaces lone surrogates and keeps pairs", () => {
    expect(usvString("a\uD800b")).toBe("a�b");
    expect(usvString("\uDC00")).toBe("�");
    expect(usvString("😀")).toBe("😀");
  });

  test.each([
    [0, 0],
    [-1, 65535],
    [65536, 0],
    [65537.9, 1],
    [-0.5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    ["42", 42],
  ])("unsignedShort(%s) is %s", (value, expected) => {
    expect(unsignedShort(value)).toBe(expected);
  });

  test("unsignedShort rejects BigInt and Symbol like ToNumber", () => {
    expect(() => unsignedShort(1n)).toThrow(TypeError);
    expect(() => unsignedShort(Symbol())).toThrow(TypeError);
  });

  test.each([
    [1.5, 2],
    [2.5, 2],
    [-1.5, -2],
    [-2.5, -2],
    [1.4, 1],
    [1.6, 2],
    [Number.NaN, 0],
    [2 ** 64, 2 ** 63 - 1],
    [-(2 ** 64), -(2 ** 63)],
  ])("clampedLongLong(%s) is %s", (value, expected) => {
    expect(clampedLongLong(value)).toBe(expected);
  });

  test("dictionary treats null and undefined as empty and rejects primitives", () => {
    expect(dictionary(undefined)).toStrictEqual({});
    expect(dictionary(null)).toStrictEqual({});
    const value = {
      a: 1,
    };
    expect(dictionary(value)).toBe(value);
    const callable = () => {};
    expect(dictionary(callable)).toBe(callable);
    expect(() => dictionary("text")).toThrow("Expected a dictionary");
  });

  test("exposeAttributes makes getters enumerable and requires them", () => {
    class Example {
      get value() {
        return 1;
      }
    }
    exposeAttributes(Example.prototype, ["value"]);
    const descriptor = Object.getOwnPropertyDescriptor(Example.prototype, "value");
    expect(descriptor).toMatchObject({
      enumerable: true,
      configurable: true,
    });
    expect(() => exposeAttributes(Example.prototype, ["missing"])).toThrow(
      "Missing attribute getter: missing",
    );
  });
});

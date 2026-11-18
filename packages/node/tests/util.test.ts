// node:util against Node's own util for the supported subset.

import * as node from "node:util";

import util from "@fetchlet/node/util";
import { describe, expect, test } from "vite-plus/test";

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

const circular: Record<string, unknown> = { name: "loop" };
circular.self = circular;

const inspected: Array<[string, unknown]> = [
  ["string", "text"],
  ["string with quote", "it's"],
  ["number", 42],
  ["negative zero", -0],
  ["bigint", 10n],
  ["symbol", Symbol("tag")],
  ["undefined", undefined],
  ["null", null],
  ["boolean", true],
  ["array", [1, "two", [3, [4, [5]]]]],
  ["sparse-free nested object", { a: 1, b: { c: { d: { e: 1 } } } }],
  ["empty object", {}],
  ["empty array", []],
  ["class instance", new Point(1, 2)],
  [
    "map",
    new Map<unknown, unknown>([
      ["a", 1],
      [2, { b: true }],
    ]),
  ],
  ["set", new Set([1, "x"])],
  ["date", new Date(Date.UTC(2020, 0, 2, 3, 4, 5))],
  ["regexp", /a+b/gi],
  ["named function", function named() {}],
  ["arrow", () => {}],
  ["class", Point],
  ["uint8array", new Uint8Array([1, 2, 3])],
  ["circular", circular],
  ["null prototype", Object.assign(Object.create(null), { a: 1 })],
  ["quoted keys", { "a-b": 1, valid_key: 2 }],
  ["long array", Array.from({ length: 30 }, (_, index) => index * 1000)],
  ["long object", { alpha: "a".repeat(20), beta: "b".repeat(20), gamma: "c".repeat(20), delta: 1 }],
];

describe("inspect", () => {
  test.each(inspected)("%s", (_name, value) => {
    expect(util.inspect(value)).toBe(node.inspect(value));
  });

  test("honors depth and the custom symbol", () => {
    const deep = { a: { b: { c: {} } } };
    expect(util.inspect(deep, { depth: 0 })).toBe(node.inspect(deep, { depth: 0 }));
    const custom = { [Symbol.for("nodejs.util.inspect.custom")]: () => "CUSTOM" };
    expect(util.inspect(custom)).toBe(node.inspect(custom));
    expect(util.inspect.custom).toBe(node.inspect.custom);
  });
});

describe("format", () => {
  test.each([
    [["%s:%s", "a"]],
    [["%d + %i = %f", "1.5", 2.7, "3"]],
    [["%j", { a: [1] }]],
    [["%o", { a: 1 }]],
    [["%O", { a: 1 }]],
    [["100%% %c done", "color: red"]],
    [["no placeholders", 1, "two", { three: 3 }]],
    [[{ a: 1 }, "b"]],
    [["%s", null, undefined]],
    [["%s", 5n]],
    [["%d", 5n]],
    [["%s", Symbol("s")]],
    [["%s", new Error("message").message]],
    [["%s", { toString: () => "custom" }]],
  ])("case %#", (args) => {
    expect(util.format(...args)).toBe(node.format(...args));
  });
});

describe("isDeepStrictEqual", () => {
  test.each([
    [{ a: [1, 2] }, { a: [1, 2] }],
    [{ a: 1 }, { a: "1" }],
    [[1, 2], { 0: 1, 1: 2 }],
    [new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])],
    [new Set([1, 2]), new Set([2, 1])],
    [new Date(1), new Date(1)],
    [new Date(1), new Date(2)],
    [NaN, NaN],
    [0, -0],
    [new Uint8Array([1]), new Uint8Array([1])],
    [new Uint8Array([1]), new Int8Array([1])],
    [circular, circular],
    [Object.create(null), {}],
    [/a/g, /a/g],
    [/a/g, /a/i],
  ])("%o and %o", (a, b) => {
    expect(util.isDeepStrictEqual(a, b)).toBe(node.isDeepStrictEqual(a, b));
  });
});

describe("promisify and callbackify", () => {
  test("promisify resolves, rejects and honors the custom symbol", async () => {
    const add = (a: number, b: number, callback: (error: Error | null, value?: number) => void) =>
      callback(null, a + b);
    const fail = (callback: (error: Error) => void) => callback(new Error("no"));
    expect(await util.promisify(add)(1, 2)).toBe(3);
    await expect(util.promisify(fail)()).rejects.toThrow("no");
    const custom = Object.assign(() => {}, {
      [node.promisify.custom]: () => Promise.resolve("custom"),
    });
    expect(await util.promisify(custom)()).toBe("custom");
    expect(util.promisify.custom).toBe(node.promisify.custom);
  });

  test("callbackify reports falsy rejections like Node", async () => {
    const outcome = (callbackify: typeof node.callbackify) =>
      new Promise((resolve) =>
        callbackify(() => Promise.reject(null))((error: unknown) =>
          resolve([(error as { code: string }).code, (error as { reason: unknown }).reason]),
        ),
      );
    expect(await outcome(util.callbackify as typeof node.callbackify)).toStrictEqual(
      await outcome(node.callbackify),
    );
  });
});

describe("types", () => {
  const values = [
    Promise.resolve(),
    new Date(),
    /x/,
    new Map(),
    new Set(),
    new WeakMap(),
    new Uint8Array(),
    new ArrayBuffer(1),
    new DataView(new ArrayBuffer(1)),
    async () => {},
    function* generator() {},
    new Number(1),
    new Error("e"),
    {},
  ];
  const checks = [
    "isPromise",
    "isDate",
    "isRegExp",
    "isMap",
    "isSet",
    "isWeakMap",
    "isUint8Array",
    "isTypedArray",
    "isArrayBuffer",
    "isAnyArrayBuffer",
    "isDataView",
    "isArrayBufferView",
    "isAsyncFunction",
    "isGeneratorFunction",
    "isBoxedPrimitive",
    "isNativeError",
  ] as const;
  test.each(checks)("%s", (check) => {
    const ours = values.map((value) =>
      (util.types as Record<string, (value: unknown) => boolean>)[check](value),
    );
    const theirs = values.map((value) =>
      (node.types as Record<string, (value: unknown) => boolean>)[check](value),
    );
    expect(ours).toStrictEqual(theirs);
  });
});

test("inherits, stripVTControlCharacters and toUSVString", () => {
  function Child() {}
  util.inherits(Child, Point);
  expect(Object.getPrototypeOf(Child.prototype)).toBe(Point.prototype);
  expect((Child as unknown as { super_: unknown }).super_).toBe(Point);
  expect(util.stripVTControlCharacters("\u001b[31mred\u001b[39m")).toBe("red");
  expect(util.toUSVString("a\ud800b")).toBe(node.toUSVString("a\ud800b"));
});

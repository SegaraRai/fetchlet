// node:assert against Node's own: which comparisons pass and fail, and the
// shape of the errors.

import * as nodeAssert from "node:assert";

import assert, { AssertionError } from "@fetchlet/node/assert";
import strict from "@fetchlet/node/assert/strict";
import { describe, expect, test } from "vite-plus/test";

/** Whether a call passes, under Node's assert and ours. */
function outcomes(call: (module: typeof nodeAssert) => unknown) {
  const run = (module: typeof nodeAssert) => {
    try {
      call(module);
      return "pass";
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).name;
    }
  };
  return [run(assert as unknown as typeof nodeAssert), run(nodeAssert)];
}

const pairs: [string, unknown, unknown][] = [
  ["numbers", 1, 1],
  ["number and string", 1, "1"],
  ["NaN", NaN, NaN],
  ["zeros", 0, -0],
  ["null and undefined", null, undefined],
  ["arrays", [1, [2, { a: 3 }]], [1, [2, { a: 3 }]]],
  ["arrays with loose items", [1, 2], ["1", "2"]],
  ["objects with different prototypes", Object.create(null), {}],
  ["dates", new Date(0), new Date(0)],
  ["different dates", new Date(0), new Date(1)],
  ["regular expressions", /a/g, /a/g],
  ["maps", new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])],
  ["sets of objects", new Set([{ a: 1 }]), new Set([{ a: 1 }])],
  ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ["symbol keys", { [Symbol.for("k")]: 1 }, {}],
  ["errors", new Error("a"), new Error("a")],
  ["boxed and primitive", new Number(1), 1],
];

describe("comparisons", () => {
  test.each(pairs)("%s compare as in Node", (_, actual, expected) => {
    for (const name of [
      "equal",
      "notEqual",
      "strictEqual",
      "notStrictEqual",
      "deepEqual",
      "notDeepEqual",
      "deepStrictEqual",
      "notDeepStrictEqual",
    ] as const) {
      const [ours, theirs] = outcomes((module) => module[name](actual, expected));
      expect([name, ours]).toStrictEqual([name, theirs]);
    }
  });

  test("ok, match and ifError", () => {
    for (const value of [0, "", null, 1, "x", {}]) {
      const [ours, theirs] = outcomes((module) => module.ok(value));
      expect(ours).toBe(theirs);
    }
    expect(outcomes((module) => module.match("abc", /b/))).toStrictEqual(["pass", "pass"]);
    expect(outcomes((module) => module.doesNotMatch("abc", /b/))).toStrictEqual([
      "ERR_ASSERTION",
      "ERR_ASSERTION",
    ]);
    expect(outcomes((module) => module.ifError(null))).toStrictEqual(["pass", "pass"]);
    expect(outcomes((module) => module.ifError(new Error("x")))).toStrictEqual([
      "ERR_ASSERTION",
      "ERR_ASSERTION",
    ]);
  });
});

describe("errors", () => {
  test("AssertionError carries Node's fields", () => {
    let error: AssertionError | undefined;
    try {
      assert.strictEqual(1, 2);
    } catch (caught) {
      error = caught as AssertionError;
    }
    expect(error).toBeInstanceOf(AssertionError);
    expect(error).toMatchObject({
      name: "AssertionError",
      code: "ERR_ASSERTION",
      actual: 1,
      expected: 2,
      operator: "strictEqual",
      generatedMessage: true,
    });
    expect(error!.message).toBe("Expected values to be strictly equal:\n\n1 !== 2\n");
    expect(() => assert.strictEqual(1, 2, "custom")).toThrow("custom");
    const own = new TypeError("own");
    expect(() => assert.ok(false, own)).toThrow(own);
    expect(() => assert.fail()).toThrow("Failed");
    expect(() => assert(false)).toThrow(AssertionError);
  });

  test("throws and rejects check what was thrown", async () => {
    const fn = () => {
      throw new TypeError("wrong value");
    };
    for (const expected of [TypeError, /wrong/, { name: "TypeError", message: /value/ }]) {
      expect(outcomes((module) => module.throws(fn, expected as RegExp))).toStrictEqual([
        "pass",
        "pass",
      ]);
    }
    expect(outcomes((module) => module.throws(fn, RangeError))).toStrictEqual([
      "ERR_ASSERTION",
      "ERR_ASSERTION",
    ]);
    expect(outcomes((module) => module.throws(() => {}))).toStrictEqual([
      "ERR_ASSERTION",
      "ERR_ASSERTION",
    ]);
    expect(outcomes((module) => module.doesNotThrow(() => {}))).toStrictEqual(["pass", "pass"]);
    expect(outcomes((module) => module.doesNotThrow(fn))).toStrictEqual([
      "ERR_ASSERTION",
      "ERR_ASSERTION",
    ]);
    await assert.rejects(Promise.reject(new Error("no")), /no/);
    await assert.doesNotReject(async () => {});
    await expect(assert.rejects(Promise.resolve())).rejects.toThrow("Missing expected rejection.");
  });
});

test("assert/strict uses the strict comparisons under every name", () => {
  expect(() => strict.equal(1, "1")).toThrow(AssertionError);
  expect(() => strict.deepEqual([1], ["1"])).toThrow(AssertionError);
  expect(strict.strict).toBe(strict);
  expect(assert.strict).toBe(strict);
  // Node's newest members are not provided.
  expect(Object.keys(nodeAssert.strict).filter((name) => !(name in strict))).toStrictEqual([
    "partialDeepStrictEqual",
    "Assert",
  ]);
});

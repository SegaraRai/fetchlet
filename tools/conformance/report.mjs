import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./sources.mjs";

export const baselineFile = resolve(root, "expectations.json");

export function key(result) {
  return JSON.stringify([result.suite, result.backend, result.file, result.mode, result.name]);
}

export function assess(results, expectations, { strict = false, complete = false } = {}) {
  const expected = new Map();
  for (const expectation of expectations) {
    if (!expectation.reason || expected.has(expectation.key))
      throw new Error("Invalid expectations");
    expected.set(expectation.key, expectation);
  }
  const observed = new Set();
  let unexpected = 0;
  for (const result of results) {
    const expectation = expected.get(key(result));
    observed.add(key(result));
    result.expected = result.status === "fail" && !!expectation;
    if (result.expected) result.reason = expectation.reason;
    if (result.status === "pass" && expectation) {
      result.unexpectedPass = true;
      unexpected++;
    } else if (!["pass", "unsupported"].includes(result.status) && (!result.expected || strict)) {
      unexpected++;
    }
  }
  const stale = complete ? [...expected.keys()].filter((entry) => !observed.has(entry)) : [];
  return { unexpected: unexpected + stale.length, expectations: expectations.length, stale };
}

export function evaluate(results, options = {}) {
  let expectations = existsSync(baselineFile)
    ? JSON.parse(readFileSync(baselineFile, "utf8")).failures
    : [];
  if (options.recordNote) {
    if (
      results.some((result) => ["runner-error", "timeout", "harness-error"].includes(result.status))
    ) {
      throw new Error("Fix runner/harness errors before recording expectations");
    }
    if (results.some((result) => result.suite === "regressions" && result.status !== "pass")) {
      throw new Error("Fix regression tests before recording expectations");
    }
    expectations = results
      .filter((result) => result.status === "fail")
      .map((result) => ({
        key: key(result),
        reason: options.recordNote,
        message: result.message,
      }));
    writeFileSync(
      baselineFile,
      JSON.stringify({ schemaVersion: 1, failures: expectations }, null, 2) + "\n",
    );
  }
  return assess(results, expectations, options);
}

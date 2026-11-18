import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeJson } from "@fetchlet-internal/tools-workspace/results";

import { root } from "./sources.ts";

export interface Result {
  suite: string;
  backend: string;
  file: string;
  mode: string;
  name: string;
  status: string;
  message?: string;
  expected?: boolean;
  reason?: string;
  unexpectedPass?: boolean;
  [key: string]: unknown;
}

export interface Expectation {
  key: string;
  reason: string;
  message?: string;
}

export interface AssessOptions {
  strict?: boolean;
  complete?: boolean;
}

export interface Verdict {
  unexpected: number;
  expectations?: number;
  stale?: string[];
  baselineError?: string;
}

export const baselineFile = resolve(root, "expectations.json");

export function key(result: Pick<Result, "suite" | "backend" | "file" | "mode" | "name">): string {
  return JSON.stringify([result.suite, result.backend, result.file, result.mode, result.name]);
}

export function assess(
  results: Result[],
  expectations: Expectation[],
  { strict = false, complete = false }: AssessOptions = {},
): Verdict {
  const expected = new Map<string, Expectation>();
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
    if (expectation && result.expected) result.reason = expectation.reason;
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

export function evaluate(
  results: Result[],
  options: AssessOptions & { recordNote?: string } = {},
): Verdict {
  const recordNote = options.recordNote;
  let expectations: Expectation[] = existsSync(baselineFile)
    ? JSON.parse(readFileSync(baselineFile, "utf8")).failures
    : [];
  if (recordNote) {
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
        reason: recordNote,
        message: result.message,
      }));
    writeJson(baselineFile, { schemaVersion: 1, failures: expectations });
  }
  return assess(results, expectations, options);
}

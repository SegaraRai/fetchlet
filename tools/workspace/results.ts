import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { root } from "./paths.ts";

/** Writes a JSON result under `results/`, which the documentation reports from. */
export function writeResult(name: string, value: unknown): void {
  writeText(name, JSON.stringify(value, null, 2) + "\n");
}

/** Writes a text file under `results/`. */
export function writeText(name: string, text: string): void {
  const file = resolve(root, "results", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A log under `results/logs/`, which is not tracked. */
export function logPath(name: string): string {
  return resolve(root, "results/logs", name);
}

/** The text of an error with its stack, for result files. */
export function describe(error: unknown): string {
  return String((error as Error)?.stack ?? error);
}

export interface PassFail {
  status: string;
}

export function summarize(rows: readonly PassFail[]) {
  return {
    passed: rows.filter((row) => row.status === "pass").length,
    failed: rows.filter((row) => row.status === "fail").length,
  };
}

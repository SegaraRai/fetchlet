import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { root as workspaceRoot } from "@fetchlet-internal/tools-workspace/paths";

export type Suite = "wpt" | "test262";

export interface SuiteLock {
  repository: string;
  revision: string;
  tests: string[];
  files: { path: string; sha256: string }[];
}

/** The conformance data directory: the source lock, expectations and pinned upstream files. */
export const root = resolve(workspaceRoot, "tests/conformance");
export const lock = JSON.parse(readFileSync(resolve(root, "sources.lock.json"), "utf8")) as {
  suites: Record<Suite, SuiteLock>;
};

export function suites(): [Suite, SuiteLock][] {
  return Object.entries(lock.suites) as [Suite, SuiteLock][];
}

export function source(suite: Suite, file: string): string {
  const record = lock.suites[suite].files.find((entry) => entry.path === file);
  if (!record) throw new Error("Unpinned upstream dependency: " + suite + "/" + file);
  const directory = resolve(root, "upstream", suite);
  const location = resolve(directory, file);
  const local = relative(directory, location);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error("Unsafe source path");
  const bytes = readFileSync(location);
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new Error("Upstream checksum mismatch: " + suite + "/" + file);
  }
  return bytes.toString("utf8");
}

export function verifySources(): void {
  for (const [suite, configuration] of suites()) {
    for (const file of configuration.files) source(suite, file.path);
  }
}

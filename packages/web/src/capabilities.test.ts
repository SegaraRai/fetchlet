import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { hostApiRequirements, hostOperations } from "./capabilities.ts";

/** The profile's module sources, without the generated protocol itself. */
function sources(): string[] {
  const directory = join(import.meta.dirname, "internal");
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "protocol.ts")
    .map((file) => readFileSync(join(directory, file), "utf8"));
}

/** The host APIs the profile's modules ask the host for. */
function checkedApis(): Set<string> {
  const checked = new Set<string>();
  for (const source of sources()) {
    for (const match of source.matchAll(/hostProvides\("([^"]+)"\)/g)) {
      checked.add(match[1]!);
    }
  }
  return checked;
}

const listed = Object.values(hostOperations).flat() as string[];

describe("hostApiRequirements", () => {
  test("names only host APIs the profile checks before it installs a global", () => {
    const checked = checkedApis();
    for (const apis of Object.values(hostApiRequirements)) {
      for (const api of apis) {
        expect(checked).toContain(api);
      }
    }
  });
});

describe("hostOperations", () => {
  test("lists every fetchlet-web operation the profile calls", () => {
    const namespaces = new Set(listed.map((operation) => operation.split(".")[0]));
    const called = new Set<string>();
    for (const source of sources()) {
      for (const [, operation, namespace] of source.matchAll(/"(([A-Za-z]+)\.[A-Za-z]+)"/g)) {
        if (namespaces.has(namespace!)) {
          called.add(operation!);
        }
      }
    }
    expect(called.size).toBeGreaterThan(0);
    for (const operation of called) {
      expect(listed, operation).toContain(operation);
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { hostApiRequirements } from "./capabilities.ts";

/** The host APIs the profile's modules ask the host for. */
function checkedApis(): Set<string> {
  const checked = new Set<string>();
  const directory = join(import.meta.dirname, "internal");
  for (const file of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(join(directory, file), "utf8");
    for (const match of source.matchAll(/hostProvides\("([^"]+)"\)/g)) {
      checked.add(match[1]!);
    }
  }
  return checked;
}

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

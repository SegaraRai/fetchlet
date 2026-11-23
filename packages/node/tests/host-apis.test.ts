import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { moduleHostApis } from "../src/host-apis.ts";

/** The modules whose implementation reaches the host functions. */
function hostModules(): Set<string> {
  const found = new Set<string>();
  const internal = join(import.meta.dirname, "../src/internal");
  for (const name of readdirSync(internal)) {
    const directory = join(internal, name);
    const files = readdirSync(directory, { recursive: true, encoding: "utf8" });
    if (
      files.some(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          readFileSync(join(directory, file), "utf8").includes('from "@fetchlet/web/host"'),
      )
    ) {
      found.add(name);
    }
  }
  return found;
}

describe("moduleHostApis", () => {
  test("lists every module that calls the host, and only those", () => {
    expect(new Set(Object.keys(moduleHostApis))).toStrictEqual(hostModules());
  });
});

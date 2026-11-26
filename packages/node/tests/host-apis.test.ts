import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hostOperations } from "@fetchlet/web/capabilities";
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

/** The fetchlet-web operations each module's implementation names. */
function operationsByModule(): Map<string, Set<string>> {
  const listed = Object.values(hostOperations).flat() as string[];
  const namespaces = new Set(listed.map((operation) => operation.split(".")[0]));
  const found = new Map<string, Set<string>>();
  const internal = join(import.meta.dirname, "../src/internal");
  for (const name of readdirSync(internal)) {
    const directory = join(internal, name);
    for (const file of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(join(directory, file), "utf8");
      for (const [, operation, namespace] of source.matchAll(/"(([A-Za-z]+)\.[A-Za-z]+)"/g)) {
        if (namespaces.has(namespace!)) {
          found.set(name, (found.get(name) ?? new Set()).add(operation!));
        }
      }
    }
  }
  return found;
}

describe("moduleHostApis", () => {
  test("lists every module that calls the host, and only those", () => {
    expect(new Set(Object.keys(moduleHostApis))).toStrictEqual(hostModules());
  });

  test("names the API of every operation a module calls", () => {
    for (const [module, operations] of operationsByModule()) {
      for (const operation of operations) {
        const api = Object.entries(hostOperations).find(([, listed]) =>
          (listed as readonly string[]).includes(operation),
        )?.[0];
        expect(api, `${operation} in protocol.json`).toBeDefined();
        expect(moduleHostApis[module], `${module} calls ${operation}`).toContain(api);
      }
    }
  });
});

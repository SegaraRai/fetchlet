import { describe, expect, test } from "vite-plus/test";

import { runtimeConditions, runtimeKey } from "./conditions.ts";

describe("runtime conditions", () => {
  test("lead with the runtime key and imply only worker", () => {
    expect(runtimeKey).toBe("fetchlet");
    expect(runtimeConditions()).toStrictEqual([
      "fetchlet",
      "worker",
      "module",
      "import",
      "production",
      "default",
    ]);
    expect(runtimeConditions("development")).toContain("development");
    for (const key of ["workerd", "edge-light", "browser", "node"]) {
      expect(runtimeConditions()).not.toContain(key);
    }
  });
});

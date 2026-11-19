// The end-to-end harness of an example that is a command line program: runs
// the example's binary, registers checks with Vitest and records
// results/example-<name>.json like the server examples.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { exampleBinary, root } from "@fetchlet-internal/tools-workspace/paths";
import {
  describe,
  environment,
  summarize,
  writeResult,
} from "@fetchlet-internal/tools-workspace/results";
import { afterAll, test } from "vite-plus/test";

import type { Feature } from "./features.ts";
import { backend, resultFile } from "./suite.ts";

/** What a run of the example's binary printed and how it exited. */
export interface CommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandSuite {
  /** Runs the example's binary with `args` on the suite's engine. */
  run(args: string[]): CommandOutput;
  /** Registers a check that records its outcome in the result file. */
  check: (name: string, features: Feature[], operation: () => Promise<void> | void) => void;
}

export function commandSuite(name: string): CommandSuite {
  const example = resolve(root, "examples", name);
  const results: { name: string; features: Feature[]; status: "pass" | "fail"; error?: string }[] =
    [];

  afterAll(() => {
    writeResult(resultFile(name), {
      environment: environment({ packagesOf: example }),
      backend,
      summary: summarize(results),
      results,
    });
  });

  return {
    run(args) {
      const result = spawnSync(exampleBinary(name), args, {
        cwd: example,
        encoding: "utf8",
        env: { ...process.env, FETCHLET_BACKEND: backend },
        timeout: 20_000,
        windowsHide: true,
      });
      if (result.error) {
        throw result.error;
      }
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    check(checkName, features, operation) {
      test(checkName, { timeout: 30_000 }, async () => {
        try {
          await operation();
          results.push({ name: checkName, features, status: "pass" });
        } catch (error) {
          results.push({ name: checkName, features, status: "fail", error: describe(error) });
          throw error;
        }
      });
    },
  };
}

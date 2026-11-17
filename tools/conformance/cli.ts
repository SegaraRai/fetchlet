// Runs the pinned WPT, Test262 and regression cases on Node and each backend
// and judges them against tests/conformance/expectations.json:
// `vp run test:conformance [-- --suite wpt --backend quickjs --filter Blob]`.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { root as workspaceRoot } from "@fetchlet-internal/tools-workspace/paths";
import { build } from "vite-plus";

import { runProcess } from "./process.ts";
import { evaluate, type Result, type Verdict } from "./report.ts";
import { lock, root, suites, verifySources } from "./sources.ts";
import { test262Program, test262Variants } from "./test262.ts";
import { wptProgram, wptScript } from "./wpt.ts";

interface Case {
  suite: string;
  file: string;
  mode: string;
  unsupported?: string | null;
  program: string | null;
  bundle?: string;
}

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "all" },
    output: { type: "string", default: "results/conformance.json" },
    backend: { type: "string" },
    filter: { type: "string", default: "" },
    timeout: { type: "string", default: "30000" },
    jobs: { type: "string", default: "2" },
    strict: { type: "boolean", default: false },
    "record-baseline": { type: "string" },
  },
});
if (!["all", "wpt", "test262", "regressions"].includes(values.suite))
  throw new Error("Unknown suite");
const backends = values.backend
  ? values.backend.split(",")
  : ["node-reference", "quickjs", "boa", "v8"];
if (backends.some((backend) => !["node-reference", "quickjs", "boa", "v8"].includes(backend))) {
  throw new Error("Unknown backend");
}
const timeoutMs = Number(values.timeout),
  jobs = Number(values.jobs);
if (
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs <= 0 ||
  !Number.isSafeInteger(jobs) ||
  jobs <= 0
) {
  throw new Error("timeout and jobs must be positive integers");
}
verifySources();
const runs = resolve(workspaceRoot, ".cache/conformance/runs");
mkdirSync(runs, { recursive: true });
const directory = mkdtempSync(resolve(runs, "run-"));
const profile = resolve(directory, "profile.js");
await build({
  configFile: false,
  resolve: { mainFields: ["module", "main"], conditions: ["module", "production"] },
  build: {
    target: "es2022",
    outDir: directory,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(workspaceRoot, "packages/runtime/src/index.ts"),
      formats: ["iife"],
      name: "fetchletProfile",
      fileName: () => "profile.js",
    },
  },
});
const prelude = readFileSync(profile, "utf8");
const cases: Case[] = [];
for (const suite of ["wpt", "test262"] as const) {
  if (values.suite !== "all" && values.suite !== suite) continue;
  for (const file of lock.suites[suite].tests) {
    if (!file.includes(values.filter)) continue;
    if (suite === "wpt")
      cases.push({ suite, file, mode: "shell", program: prelude + "\n" + wptProgram(file) });
    else
      for (const variant of test262Variants(file)) {
        cases.push({
          suite,
          file,
          mode: variant.mode,
          unsupported: variant.unsupported,
          program: variant.unsupported ? null : test262Program(variant),
        });
      }
  }
}
if (values.suite === "all" || values.suite === "regressions") {
  const file = "regressions/web-api.any.js";
  if (file.includes(values.filter))
    cases.push({
      suite: "regressions",
      file,
      mode: "shell",
      program: prelude + "\n" + wptScript([readFileSync(resolve(root, file), "utf8")]),
    });
}
if (cases.length === 0) throw new Error("No selected cases");
const work: (Case & { backend: string })[] = [];
for (const [index, test] of cases.entries()) {
  if (test.program) {
    test.bundle = resolve(directory, index + ".js");
    writeFileSync(test.bundle, test.program);
  }
  for (const backend of backends) work.push({ ...test, backend });
}
const results: Result[] = [];
let cursor = 0;
async function worker(): Promise<void> {
  for (;;) {
    const task = work[cursor++];
    if (!task) return;
    const identity = { suite: task.suite, file: task.file, mode: task.mode, backend: task.backend };
    if (task.unsupported) {
      results.push({
        ...identity,
        name: "environment",
        status: "unsupported",
        message: task.unsupported,
      });
      continue;
    }
    const started = performance.now();
    const execution = await runProcess(task.backend, task.bundle!, timeoutMs, task.suite);
    if (execution.status !== "complete") {
      results.push({
        ...identity,
        name: "environment",
        status: execution.status,
        message: execution.message,
      });
      continue;
    }
    const report = execution.value;
    if (report.harness?.status !== undefined && report.harness.status !== 0) {
      results.push({
        ...identity,
        name: "harness",
        status: "harness-error",
        message: report.harness.message,
      });
    }
    if (!Array.isArray(report.tests) || report.tests.length === 0) {
      results.push({
        ...identity,
        name: "harness",
        status: "harness-error",
        message: "No tests reported",
      });
      continue;
    }
    for (const test of report.tests)
      results.push({
        ...identity,
        name: test.name,
        status:
          test.status === 0
            ? "pass"
            : test.status === 1
              ? "fail"
              : test.status === 2
                ? "timeout"
                : "harness-error",
        message: test.message,
        fileDurationMs: performance.now() - started,
      });
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, work.length) }, worker));
results.sort((a, b) =>
  JSON.stringify([a.suite, a.backend, a.file, a.mode, a.name]).localeCompare(
    JSON.stringify([b.suite, b.backend, b.file, b.mode, b.name]),
  ),
);
if (values["record-baseline"] && (values.suite !== "all" || values.backend || values.filter)) {
  throw new Error("Record expectations using a complete selected matrix");
}
let verdict: Verdict;
try {
  verdict = evaluate(results, {
    strict: values.strict,
    recordNote: values["record-baseline"],
    complete: values.suite === "all" && !values.backend && !values.filter,
  });
} catch (error) {
  verdict = { unexpected: 1, baselineError: String((error as Error).message) };
}
const summary: Record<
  string,
  { pass: number; fail: number; expectedFailures: number; unsupported: number; errors: number }
> = {};
for (const result of results) {
  const group = result.suite + "/" + result.backend;
  summary[group] ??= { pass: 0, fail: 0, expectedFailures: 0, unsupported: 0, errors: 0 };
  const count = summary[group];
  if (result.status === "pass") count.pass++;
  else if (result.status === "fail") {
    count.fail++;
    if (result.expected) count.expectedFailures++;
  } else if (result.status === "unsupported") count.unsupported++;
  else count.errors++;
}
const report = {
  checkedAt: new Date().toISOString(),
  scope: "Pinned, selected upstream tests; WPT shell and Test262 script subsets",
  sources: Object.fromEntries(
    suites().map(([suite, source]) => [
      suite,
      {
        repository: source.repository,
        revision: source.revision,
        selectedFiles: source.tests.length,
      },
    ]),
  ),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    profileSha256: createHash("sha256").update(prelude).digest("hex"),
    cargoLockSha256: sha256(resolve(workspaceRoot, "Cargo.lock")),
    pnpmLockSha256: sha256(resolve(workspaceRoot, "pnpm-lock.yaml")),
  },
  options: {
    suite: values.suite,
    backends,
    filter: values.filter,
    timeoutMs,
    jobs,
    strict: values.strict,
  },
  verdict,
  summary,
  results,
};
const output = resolve(workspaceRoot, values.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ summary, verdict }, null, 2));
process.exitCode = verdict.unexpected > 0 ? 1 : 0;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

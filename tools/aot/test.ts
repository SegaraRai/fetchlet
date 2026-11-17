// Compiles the AOT fixtures with Perry and scriptc into native executables,
// runs them and records results/aot-matrix.json: `vp run test:aot`.
// With --bundled, only the bundled ES2019 rows are measured again.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";
import { writeResult, writeText } from "@fetchlet-internal/tools-workspace/results";

import { compilerEnv, perry, releases, scriptc } from "./toolchain.ts";

interface Execution {
  code: number | null;
  timedOut?: boolean;
  error?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface Row {
  backend: string;
  suite: string;
  inputMode: string;
  inputSha256: string;
  mode: string;
  compiler: string;
  build: { code: number | null; timedOut?: boolean; durationMs: number };
  status: "pass" | "fail";
  execution?: Execution;
  error?: string;
}

const outputDirectory = resolve(root, "artifacts/aot");
mkdirSync(outputDirectory, { recursive: true });
const bundledOnly = process.argv.includes("--bundled");
const results: Row[] = bundledOnly
  ? (
      JSON.parse(readFileSync(resolve(root, "results/aot-matrix.json"), "utf8")).results as Row[]
    ).filter((row) => row.inputMode !== "bundled-es2019")
  : [];

function execute(command: string, args: string[], timeout = 180_000): Promise<Execution> {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: compilerEnv() });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        code: null,
        error: String(error),
        stdout,
        stderr,
        durationMs: performance.now() - started,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, timedOut, stdout, stderr, durationMs: performance.now() - started });
    });
  });
}

function verify(fixture: string, execution: Execution): void {
  if (execution.code !== 0) {
    throw new Error(`Executable exited ${execution.code}: ${execution.stderr.slice(-2000)}`);
  }
  const value = JSON.parse(execution.stdout.trim().split(/\r?\n/).at(-1) ?? "null");
  if (fixture === "plain") {
    if (value.add !== 42 || value.transform.sum !== 6 || value.async.value !== "ok") {
      throw new Error("Incorrect function result");
    }
  } else {
    const html = new TextDecoder().decode(new Uint8Array(value.body));
    if (value.status !== 200 || !html.includes("Hello, Rust")) {
      throw new Error("Incorrect HTTP result: " + html.slice(0, 600));
    }
  }
}

const variants = bundledOnly
  ? ["hono-bundled", "sveltekit-bundled"]
  : ["plain", "hono", "sveltekit", "hono-bundled", "sveltekit-bundled"];

await Promise.all(
  (["perry", "scriptc"] as const).map(async (backend) => {
    const command = backend === "perry" ? perry : scriptc;
    for (const variant of variants) {
      const fixture = variant.replace("-bundled", "");
      const bundled = variant.endsWith("-bundled");
      const output = resolve(outputDirectory, `${backend}-${variant}.exe`);
      const input = resolve(
        root,
        bundled ? `artifacts/aot-${fixture}.js` : `fixtures/aot/${fixture}.ts`,
      );
      const args =
        backend === "perry" ? ["compile", input, "-o", output] : ["build", input, "-o", output];
      const build = await execute(command, args);
      writeText(`logs/${backend}-${variant}-build.log`, build.stdout + "\n" + build.stderr);
      const row: Row = {
        backend,
        suite: fixture,
        inputMode: bundled ? "bundled-es2019" : "module-source",
        inputSha256: createHash("sha256").update(readFileSync(input)).digest("hex"),
        mode: "native-executable",
        compiler: releases[backend].version,
        build: { code: build.code, timedOut: build.timedOut, durationMs: build.durationMs },
        status: "fail",
      };
      if (build.code === 0) {
        const execution = await execute(output, [], 30_000);
        row.execution = execution;
        try {
          verify(fixture, execution);
          row.status = "pass";
        } catch (error) {
          row.error = String(error);
        }
      } else {
        row.error = (
          build.stderr ||
          build.stdout ||
          build.error ||
          `Compiler exited ${build.code}; timedOut=${build.timedOut}`
        ).slice(-5000);
      }
      results.push(row);
      console.log(`${backend}/${variant}: ${row.status}`);
      writeResult("aot-matrix.json", { checkedAt: new Date().toISOString(), results });
    }
  }),
);
if (results.some((row) => row.status === "fail")) process.exitCode = 1;

// Runs each cargo-fuzz target with AddressSanitizer for a bounded time and
// records the outcome in results/fuzz-smoke.json: `vp run test:fuzz`.
//
//   node tools/rust/fuzz.ts [--runs 1000000] [--seconds 30]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { cargoEnv } from "@fetchlet-internal/tools-workspace/cargo";
import { root, toolCache } from "@fetchlet-internal/tools-workspace/paths";
import { prependPath, run } from "@fetchlet-internal/tools-workspace/process";
import { environment, writeResult } from "@fetchlet-internal/tools-workspace/results";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "1000000" },
    seconds: { type: "string", default: "30" },
  },
});
const runs = boundedInteger("runs", values.runs, 100_000_000);
const seconds = boundedInteger("seconds", values.seconds, 3600);
const maxInputBytes = 16384;
// fetch_service: the Rust host fetch boundary. bridge_bodies: byte handles
// and body sources as a guest drives them through the native protocol.
const targets = ["fetch_service", "bridge_bodies"];

const env = fuzzEnv();
const results = targets.map((target) => {
  const log = resolve(root, `.cache/fuzz-${target}.log`);
  const code = run(
    "cargo",
    [
      "+nightly",
      "fuzz",
      "run",
      target,
      "--",
      `-runs=${runs}`,
      `-max_total_time=${seconds}`,
      `-max_len=${maxInputBytes}`,
    ],
    { env, log },
  );
  const output = readFileSync(log, "utf8");
  const completed = /Done (\d+) runs/.exec(output);
  console.log(`== ${target}`);
  console.log(output.trimEnd().split(/\r?\n/).slice(-8).join("\n"));
  return {
    target,
    status: code === 0 && completed ? "pass" : "fail",
    completedRuns: completed ? Number(completed[1]) : 0,
  };
});

writeResult("fuzz-smoke.json", {
  environment: environment(),
  sanitizer: "address",
  requestedRuns: runs,
  timeBudgetSeconds: seconds,
  compiler: execFileSync("rustc", ["+nightly", "--version"], { encoding: "utf8" }).trim(),
  maxInputBytes,
  targets: results,
});
if (results.some((result) => result.status !== "pass")) process.exitCode = 1;

/** cargo-fuzz from the tool cache, and on Windows the MSVC AddressSanitizer runtime. */
function fuzzEnv(): NodeJS.ProcessEnv {
  const directories: string[] = [];
  if (process.platform === "win32") directories.push(msvcCompilerBin());
  const localTools = join(toolCache, "cargo-fuzz", "bin");
  if (existsSync(localTools)) directories.push(localTools);
  return cargoEnv(prependPath(directories));
}

function msvcCompilerBin(): string {
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio\\Installer\\vswhere.exe",
  );
  const installation = existsSync(vswhere)
    ? execFileSync(
        vswhere,
        [
          "-latest",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-property",
          "installationPath",
        ],
        { encoding: "utf8" },
      ).trim()
    : "";
  if (!installation)
    throw new Error("MSVC tools and C++ AddressSanitizer are required for Windows fuzzing.");
  const toolchains = join(installation, "VC\\Tools\\MSVC");
  const latest = readdirSync(toolchains).sort().at(-1);
  if (!latest) throw new Error("No MSVC toolchain is installed.");
  const bin = join(toolchains, latest, "bin\\Hostx64\\x64");
  if (!existsSync(join(bin, "clang_rt.asan_dynamic-x86_64.dll"))) {
    throw new Error("Install the Visual Studio C++ AddressSanitizer component to run fuzzing.");
  }
  return bin;
}

function boundedInteger(name: string, text: string, max: number): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

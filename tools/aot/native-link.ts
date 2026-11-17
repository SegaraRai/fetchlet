// Links the AOT compilers' static libraries into Rust programs and runs them,
// recording each stage in results/native-link-matrix.json: `vp run test:aot-link`.
// Run `vp run setup:aot` first.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";
import { logPath, writeResult } from "@fetchlet-internal/tools-workspace/results";

import { compilerEnv, perry, perryDirectory, releases, scriptc, zig } from "./toolchain.ts";

interface Row {
  backend: string;
  stage: string;
  status: "pass" | "fail";
  exitCode: number;
  log: string;
  diagnostics: string;
}

const artifacts = resolve(root, "artifacts/aot");
const here = import.meta.dirname;
mkdirSync(artifacts, { recursive: true });
const env = compilerEnv();
const rows: Row[] = [];

/** Runs one stage with its output in results/logs/<log>.log and records it. */
function stage(
  backend: string,
  name: string,
  log: string,
  command: string,
  args: string[],
): boolean {
  const file = logPath(log + ".log");
  const exitCode = run(command, args, { env, log: file });
  rows.push({
    backend,
    stage: name,
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    log: `results/logs/${log}.log`,
    diagnostics: readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-18).join("\n"),
  });
  return exitCode === 0;
}

const artifact = (file: string) => resolve(artifacts, file);
const nativeHost = resolve(here, "native-host.rs");

if (
  stage("perry", "static-library", "perry-static-build", perry, [
    "compile",
    resolve(root, "fixtures/aot/native.ts"),
    "--output-type",
    "staticlib",
    "-o",
    artifact("perry-native.lib"),
  ])
) {
  // Symbols and signatures are specific to this fixture, verified using Perry's LLVM output.
  if (
    stage("perry", "rust-msvc-link", "perry-rust-msvc", "rustc", [
      "--edition=2024",
      "--cfg",
      "perry",
      nativeHost,
      "-L",
      artifacts,
      "-L",
      perryDirectory,
      "-l",
      "static=perry-native",
      "-l",
      "static=perry_runtime",
      "-l",
      "static=perry_stdlib",
      "-o",
      artifact("rust-perry-host.exe"),
    ])
  ) {
    stage("perry", "rust-msvc-execution", "perry-rust-run", artifact("rust-perry-host.exe"), []);
  }
}

if (
  stage("scriptc", "static-library", "scriptc-static-build", scriptc, [
    "build",
    "--lib",
    "--profile",
    resolve(root, "fixtures/aot/native.profile.json"),
    "-o",
    artifact("scriptc-native.lib.a"),
  ])
) {
  copyFileSync(artifact("scriptc-native.lib.a"), artifact("scriptc-native.lib"));
  if (
    stage("scriptc", "rust-msvc-link", "scriptc-rust-msvc", "rustc", [
      "--edition=2024",
      "--cfg",
      "scriptc",
      nativeHost,
      "-L",
      artifacts,
      "-l",
      "static=scriptc-native",
      "-o",
      artifact("rust-scriptc-host.exe"),
    ])
  ) {
    stage(
      "scriptc",
      "rust-msvc-execution",
      "scriptc-rust-run",
      artifact("rust-scriptc-host.exe"),
      [],
    );
  }
  // scriptc reports an MSVC target but its native driver uses the GNU CRT.
  // This extra probe keeps Rust in charge of the TS calls, with a C entry point.
  if (
    stage("scriptc", "rust-object", "scriptc-rust-object", "rustc", [
      "--edition=2024",
      "--crate-type",
      "lib",
      "--emit=obj",
      "-C",
      "panic=abort",
      resolve(here, "rust-probe.rs"),
      "-o",
      artifact("rust-scriptc-probe.obj"),
    ]) &&
    stage("scriptc", "rust-with-c-gnu-bootstrap-link", "scriptc-gnu-link", zig, [
      "cc",
      "-target",
      "x86_64-windows-gnu",
      resolve(here, "c-bootstrap.c"),
      artifact("rust-scriptc-probe.obj"),
      artifact("scriptc-native.lib.a"),
      "-Wl,--gc-sections",
      "-ladvapi32",
      "-liphlpapi",
      "-lws2_32",
      "-o",
      artifact("rust-scriptc-gnu-host.exe"),
    ])
  ) {
    stage(
      "scriptc",
      "rust-with-c-gnu-bootstrap-execution",
      "scriptc-gnu-run",
      artifact("rust-scriptc-gnu-host.exe"),
      [],
    );
  }
}

writeResult("native-link-matrix.json", {
  checkedAt: new Date().toISOString(),
  target: "x86_64-pc-windows-msvc",
  perry: releases.perry.version,
  scriptc: releases.scriptc.version,
  zig: releases.zig.version,
  results: rows,
});
console.table(rows.map(({ backend, stage, status }) => ({ backend, stage, status })));
if (rows.some((row) => row.status === "fail")) process.exitCode = 1;

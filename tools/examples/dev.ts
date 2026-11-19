// Runs an example for development: `vp build --watch` rewrites its artifact
// while the Rust server, built with the example's `dev` feature, reloads it.
// Run from the example's directory after one build, as its `dev` task does:
//
//   node ../../tools/examples/dev.ts <cargo package>

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { cargoEnv } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";

const cargoPackage = process.argv[2];
if (!cargoPackage) {
  console.error("usage: node tools/examples/dev.ts <cargo package>");
  process.exit(2);
}

const windows = process.platform === "win32";

const children: ChildProcess[] = [
  // `vp` is a `.cmd` shim on Windows, which only a shell can start.
  spawn("vp", ["build", "--watch"], { stdio: "inherit", shell: windows }),
  spawn(
    process.execPath,
    [
      resolve(root, "tools/workspace/cargo.ts"),
      "run",
      "--locked",
      "-p",
      cargoPackage,
      "--features",
      "dev",
    ],
    { stdio: "inherit", env: cargoEnv() },
  ),
];

let exiting = false;

/** Stop every child, with its own children, and exit with `code`. */
function stop(code: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) {
      continue;
    }
    if (windows) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code) => stop(code ?? 1));
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

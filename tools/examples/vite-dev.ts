// Runs an example from a Vite dev server: Vite serves the browser modules
// with hot module replacement and the server module through
// `fetchlet/vite`'s runner endpoints, and the Rust server, built with the
// example's `vite-dev` feature, runs that module in its engine and forwards
// what it does not route itself to Vite. Run from the example's directory,
// as its `dev:vite` task does:
//
//   node ../../tools/examples/vite-dev.ts <cargo package> <vite port>
//
// Extra arguments after `--` go to `cargo run`, such as `--features boa`
// together with FETCHLET_BACKEND=boa for Vite.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { cargoEnv } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";

const [cargoPackage, port, ...rest] = process.argv.slice(2);
if (!cargoPackage || !port || !/^\d+$/.test(port)) {
  console.error(
    "usage: node tools/examples/vite-dev.ts <cargo package> <vite port> [-- <cargo run arguments>]",
  );
  process.exit(2);
}
const cargoArguments = rest[0] === "--" ? rest.slice(1) : rest;

const windows = process.platform === "win32";
const viteUrl = `http://127.0.0.1:${port}`;

/** How long Vite may take to start listening. */
const startTimeoutMs = 30_000;

// `vp` is a `.cmd` shim on Windows, which only a shell can start.
const vite: ChildProcess = spawn(
  "vp",
  ["dev", "--host", "127.0.0.1", "--port", port, "--strictPort"],
  { stdio: "inherit", shell: windows },
);

/** Vite, then the Rust server once Vite listens. */
const children: ChildProcess[] = [vite];
let exiting = false;

/** Stop `child` and the processes it started. */
function kill(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (windows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function stop(code: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  children.forEach(kill);
  process.exit(code);
}

vite.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

/** Waits until Vite answers any request. */
async function viteListening(): Promise<void> {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${viteUrl}/@vite/client`, { method: "HEAD" });
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Vite did not start listening at ${viteUrl}`);
}

try {
  await viteListening();
} catch (error) {
  console.error(error);
  stop(1);
}

const server = spawn(
  process.execPath,
  [
    resolve(root, "tools/workspace/cargo.ts"),
    "run",
    "--locked",
    "-p",
    cargoPackage,
    "--features",
    "vite-dev",
    ...cargoArguments,
  ],
  { stdio: "inherit", env: { ...cargoEnv(), FETCHLET_VITE_URL: viteUrl } },
);
children.push(server);
server.on("exit", (code) => stop(code ?? 1));
server.on("error", (error) => {
  console.error(error);
  stop(1);
});

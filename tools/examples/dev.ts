// Runs an example for development: rebuilds its artifact with the example's
// `build` task whenever a watched source changes, while the Rust server,
// built with the example's `dev` feature, serves each new build. Run from the
// example's directory after one build, as its `dev` task does:
//
//   node ../../tools/examples/dev.ts <cargo package> <watched path>...
//
// Watched paths are files or directories relative to the example. A change
// counts when a file's content differs from what was last seen, so files a
// build rewrites unchanged, such as generated route tables, do not start
// another build.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";

import { cargoEnv } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";

const [cargoPackage, ...watchedPaths] = process.argv.slice(2);
if (!cargoPackage || watchedPaths.length === 0) {
  console.error("usage: node tools/examples/dev.ts <cargo package> <watched path>...");
  process.exit(2);
}

const windows = process.platform === "win32";
const example = process.cwd();
const watched = watchedPaths.map((path) => resolve(example, path));

/** How long to wait after a change for more changes before building. */
const settleMs = 100;

function isWatched(file: string): boolean {
  return watched.some((path) => file === path || file.startsWith(path + sep));
}

/** The files under `path`, or `path` itself when it is a file. */
function filesUnder(path: string): string[] {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return [];
  }
  if (stats.isFile()) {
    return [path];
  }
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The content hash of `file`, or undefined when it is missing or not a file. */
function contentHash(file: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

const seen = new Map<string, string | undefined>();

function snapshot(): void {
  seen.clear();
  for (const file of watched.flatMap(filesUnder)) {
    seen.set(file, contentHash(file));
  }
}

let building = false;
let pending = false;
let timer: NodeJS.Timeout | undefined;
let builder: ChildProcess | undefined;

function build(): void {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  pending = false;
  console.log("[dev] building");
  const started = Date.now();
  // `vp` is a `.cmd` shim on Windows, which only a shell can start.
  builder = spawn("vp", ["run", "build"], { stdio: "inherit", shell: windows });
  builder.on("exit", (code) => {
    building = false;
    builder = undefined;
    console.log(
      code === 0
        ? `[dev] built in ${Date.now() - started} ms`
        : `[dev] build failed with exit code ${code}; the server keeps the previous build`,
    );
    // What the build itself rewrote is not a change to build again for;
    // edits made while it ran have already set `pending`.
    snapshot();
    if (pending) {
      build();
    }
  });
}

snapshot();
const watcher = watch(example, { recursive: true }, (_event, name) => {
  if (!name) {
    return;
  }
  const file = resolve(example, name);
  if (!isWatched(file)) {
    return;
  }
  const hash = contentHash(file);
  if (hash === undefined && !seen.has(file)) {
    // A directory, or a file that came and went.
    return;
  }
  if (seen.get(file) === hash) {
    return;
  }
  seen.set(file, hash);
  clearTimeout(timer);
  timer = setTimeout(build, settleMs);
});

const server: ChildProcess = spawn(
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
);

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

/** Stop watching, stop the server and any build, and exit with `code`. */
function stop(code: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  watcher.close();
  clearTimeout(timer);
  kill(builder);
  kill(server);
  process.exit(code);
}

server.on("exit", (code) => stop(code ?? 1));
server.on("error", (error) => {
  console.error(error);
  stop(1);
});
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

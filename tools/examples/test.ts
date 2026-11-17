// Builds and tests framework examples end to end: `vp run test:examples`,
// or `vp run test:examples -- sveltekit-axum honox-tauri` for a selection.
//
// Each example builds its JavaScript, then its Rust server, then runs every
// suite in its tests/ directory (e2e, and desktop for an example with a window).
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { cargo } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";

const examples = readdirSync(resolve(root, "examples"), { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(resolve(root, "examples", entry.name, "tests")),
  )
  .map((entry) => entry.name)
  .sort();

const requested = process.argv.slice(2).filter((argument) => argument !== "--");
for (const name of requested) {
  if (!examples.includes(name))
    throw new Error(`Unknown example ${name}; choose from ${examples.join(", ")}`);
}

for (const name of requested.length ? requested : examples) {
  console.log(`[examples] ${name}`);
  const tests = resolve(root, "examples", name, "tests");
  const suites = readdirSync(tests)
    .filter((file) => /\.m?[jt]s$/.test(file))
    .map((file) => resolve(tests, file));
  const steps = [
    () => run("vp", ["run", "--filter", `@fetchlet-internal/example-${name}`, "build"]),
    () => cargo(["build", "--locked", "--package", `example-${name}`]),
    () => run(process.execPath, ["--test", ...suites]),
  ];
  for (const step of steps) {
    const code = step();
    if (code !== 0) process.exit(code);
  }
}

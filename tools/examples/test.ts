// Builds and tests framework examples end to end: `vp run test:examples`,
// or `vp run test:examples -- sveltekit-axum honox-tauri` for a selection.
// `--backends quickjs,boa,v8` runs each example on several engines; the
// default is QuickJS.
//
// Each example builds its JavaScript for the engine (FETCHLET_BACKEND), then
// its Rust server with the engine's feature, then runs every suite in its
// tests/ directory (e2e, and desktop for an example with a window). QuickJS
// runs last, so the examples' build/ directories end on the default engine.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { cargo } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";

const engines = ["boa", "v8", "quickjs"] as const;

const examples = readdirSync(resolve(root, "examples"), { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(resolve(root, "examples", entry.name, "tests")),
  )
  .map((entry) => entry.name)
  .sort();

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: { backends: { type: "string", default: "quickjs" } },
  allowPositionals: true,
});
for (const name of positionals) {
  if (!examples.includes(name)) {
    throw new Error(`Unknown example ${name}; choose from ${examples.join(", ")}`);
  }
}
const requestedBackends = values.backends.split(",").map((backend) => backend.trim());
for (const backend of requestedBackends) {
  if (!(engines as readonly string[]).includes(backend)) {
    throw new Error(`Unknown backend ${backend}; choose from ${engines.join(", ")}`);
  }
}
const backends = engines.filter((backend) => requestedBackends.includes(backend));

for (const name of positionals.length ? positionals : examples) {
  const example = resolve(root, "examples", name);
  for (const backend of backends) {
    console.log(`[examples] ${name} on ${backend}`);
    const env = { ...process.env, FETCHLET_BACKEND: backend };
    // An example with a `vite-dev` feature also checks its `dev:vite` loop;
    // the server runs from Vite only when FETCHLET_VITE_URL is set.
    const viteDev = /^vite-dev = /m.test(readFileSync(resolve(example, "Cargo.toml"), "utf8"));
    const enabled = [...(backend === "quickjs" ? [] : [backend]), ...(viteDev ? ["vite-dev"] : [])];
    const features = enabled.length ? ["--features", enabled.join(",")] : [];
    const steps = [
      () => run("vp", ["run", "--filter", `@fetchlet-internal/example-${name}`, "build"], { env }),
      () => cargo(["build", "--locked", "--package", `example-${name}`, ...features], { env }),
      () => run("vp", ["test", "--run", "--config", "acceptance.config.ts"], { cwd: example, env }),
    ];
    for (const step of steps) {
      const code = step();
      if (code !== 0) {
        process.exit(code);
      }
    }
  }
}

// Packs the fetchlet npm package and checks it as a user installs it:
// `vp run test:package`. A separate project under .cache/tools/package
// installs the tarball from the local pnpm store, resolves every export and
// its declarations, type-checks an import of each typed entry, builds an
// artifact with fetchlet/build and runs it on QuickJS through fetchlet-lab.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { runLab } from "@fetchlet-internal/tools-workspace/lab";
import { root, toolCache } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";

const packageDirectory = resolve(root, "packages/fetchlet");
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const workDirectory = resolve(toolCache, "package");
const consumer = resolve(workDirectory, "consumer");
const tarball = resolve(workDirectory, `fetchlet-${manifest.version}.tgz`);
const workspaceManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
// The Vite build the workspace resolves, installed under the name users depend on.
const viteCore = JSON.parse(
  readFileSync(resolve(root, "packages/fetchlet/node_modules/vite/package.json"), "utf8"),
);

rmSync(workDirectory, { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });
step(
  "pack",
  run("vp", ["pm", "pack", "--pack-destination", workDirectory], { cwd: packageDirectory }),
);
assert.ok(existsSync(tarball), `vp pm pack wrote ${tarball}`);

// The consumer's sources, plus a manifest naming this tarball and the same
// Vite as the workspace.
cpSync(resolve(import.meta.dirname, "consumer"), consumer, { recursive: true });
writeFileSync(
  resolve(consumer, "package.json"),
  JSON.stringify(
    {
      name: "fetchlet-package-consumer",
      private: true,
      type: "module",
      dependencies: {
        fetchlet: `file:../${basename(tarball)}`,
        vite: `npm:${viteCore.name}@${viteCore.version}`,
      },
      devDependencies: { typescript: "~6.0.3" },
      packageManager: workspaceManifest.packageManager,
    },
    null,
    2,
  ) + "\n",
);

step("install", run("vp", ["install", "--offline"], { cwd: consumer }));
step("exports and build", run(process.execPath, ["check.ts"], { cwd: consumer }));
step(
  "types",
  run(process.execPath, [resolve(consumer, "node_modules/typescript/bin/tsc"), "-p", "."], {
    cwd: consumer,
  }),
);

const session = runLab(
  ["quickjs", resolve(consumer, "artifact/server.js")],
  [{ fetch: { method: "GET", url: "https://app.test/hello" } }],
);
assert.deepEqual(
  session.replies,
  [{ ok: true, value: { status: 200, body: "packed /hello" } }],
  session.stderr,
);
console.log("[package] the packed fetchlet package builds and runs an artifact");

function step(name: string, code: number): void {
  if (code !== 0) {
    console.error(`[package] ${name} failed with exit code ${code}`);
    process.exit(code);
  }
}

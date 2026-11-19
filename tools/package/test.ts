// Packs the npm packages and checks them as a user installs them:
// `vp run test:package`. A separate project under .cache/tools/package
// installs fetchlet from its tarball, with @fetchlet/web and @fetchlet/node
// from theirs, resolves every export and its declarations, type-checks an
// import of each typed entry, builds an artifact with fetchlet/build and runs
// it on QuickJS through fetchlet-lab, and runs the `fetchlet dev` command.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

import { runLab } from "@fetchlet-internal/tools-workspace/lab";
import { root, toolCache } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";

/** The published packages, by directory under packages/. */
const packages = ["fetchlet", "web", "node"];

const workDirectory = resolve(toolCache, "package");
const consumer = resolve(workDirectory, "consumer");
const workspaceManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
// The Vite build the workspace resolves, installed under the name users depend on.
const viteCore = JSON.parse(
  readFileSync(resolve(root, "packages/fetchlet/node_modules/vite/package.json"), "utf8"),
);

rmSync(workDirectory, { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });

/** The tarball of each package, by package name. */
const tarballs: Record<string, string> = {};
for (const directory of packages) {
  const packageDirectory = resolve(root, "packages", directory);
  const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
  // pnpm names a scoped package's tarball without the @ and with - for /.
  const tarball = resolve(
    workDirectory,
    `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`,
  );
  step(
    `pack ${manifest.name}`,
    run("vp", ["pm", "pack", "--pack-destination", workDirectory], { cwd: packageDirectory }),
  );
  assert.ok(existsSync(tarball), `vp pm pack wrote ${tarball}`);
  // A module from node_modules in dist/ is a dependency the manifest does not
  // declare, which would ship a copy apart from the one the user installs.
  assert.ok(
    !existsSync(resolve(packageDirectory, "dist/node_modules")),
    `${manifest.name}: dist/ contains modules from node_modules; declare them as dependencies or peers`,
  );
  tarballs[manifest.name] = `file:../${basename(tarball)}`;
}

// The consumer's sources, plus a manifest naming the fetchlet tarball and the
// same Vite as the workspace. The overrides install the packages fetchlet
// depends on from their tarballs instead of the registry.
cpSync(resolve(import.meta.dirname, "consumer"), consumer, { recursive: true });
writeFileSync(
  resolve(consumer, "package.json"),
  JSON.stringify(
    {
      name: "fetchlet-package-consumer",
      private: true,
      type: "module",
      dependencies: {
        fetchlet: tarballs.fetchlet,
        vite: `npm:${viteCore.name}@${viteCore.version}`,
      },
      devDependencies: { typescript: "~6.0.3" },
      packageManager: workspaceManifest.packageManager,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  resolve(consumer, "pnpm-workspace.yaml"),
  readFileSync(resolve(consumer, "pnpm-workspace.yaml"), "utf8") +
    "overrides:\n" +
    Object.entries(tarballs)
      .filter(([name]) => name !== "fetchlet")
      .map(([name, specifier]) => `  "${name}": "${specifier}"\n`)
      .join(""),
);

// Prefer the local store, but fetch what it lacks, such as the pinned pnpm on a
// fresh CI runner.
step("install", run("vp", ["install", "--prefer-offline"], { cwd: consumer }));
step("exports and build", run(process.execPath, ["check.ts"], { cwd: consumer }));
step(
  "types",
  run(process.execPath, [resolve(consumer, "node_modules/typescript/bin/tsc"), "-p", "."], {
    cwd: consumer,
  }),
);

// The declarations of @fetchlet/web and @fetchlet/node, which applications
// may import directly, must compile on their own in the strictest setting:
// strict, without skipLibCheck. fetchlet's own declarations name the
// framework peers, so the consumer's types step covers them instead.
const fetchletDirectory = realpathSync(resolve(consumer, "node_modules/fetchlet"));
writeFileSync(
  resolve(consumer, "tsconfig.declarations.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        // addAbortListener returns a Disposable, as in Node, which needs the
        // disposable lib for Symbol.dispose.
        lib: ["ES2022", "ESNext.Disposable", "DOM", "DOM.Iterable"],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      include: ["web", "node"].map((name) =>
        resolve(fetchletDirectory, "../@fetchlet", name, "dist/**/*.d.ts").replaceAll("\\", "/"),
      ),
    },
    null,
    2,
  ) + "\n",
);
step(
  "declarations",
  run(
    process.execPath,
    [resolve(consumer, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.declarations.json"],
    { cwd: consumer },
  ),
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
console.log("[package] the packed npm packages build and run an artifact, and fetchlet dev runs");

function step(name: string, code: number): void {
  if (code !== 0) {
    console.error(`[package] ${name} failed with exit code ${code}`);
    process.exit(code);
  }
}

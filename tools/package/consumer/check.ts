// Runs inside the consumer project against the installed tarball.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { buildArtifact } from "fetchlet/build";

// Where each published package is installed: fetchlet as the consumer's
// dependency, @fetchlet/web and @fetchlet/node beside the package that depends
// on them in pnpm's store.
const fetchletDirectory = realpathSync("node_modules/fetchlet");
const nodeDirectory = realpathSync(join(fetchletDirectory, "../@fetchlet/node"));
const installed: Record<string, string> = {
  fetchlet: fetchletDirectory,
  "@fetchlet/web": realpathSync(join(fetchletDirectory, "../@fetchlet/web")),
  "@fetchlet/node": nodeDirectory,
};
// @fetchlet/node resolves the same @fetchlet/web as fetchlet.
assert.equal(
  realpathSync(join(nodeDirectory, "../web")),
  installed["@fetchlet/web"],
  "fetchlet and @fetchlet/node share one @fetchlet/web",
);

for (const [name, directory] of Object.entries(installed)) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.name, name);
  // The published manifest names compiled files and no workspace or catalog protocol.
  assert.equal(JSON.stringify(manifest).includes("workspace:"), false, name);
  assert.equal(JSON.stringify(manifest).includes("catalog:"), false, name);
  const require = createRequire(join(directory, "package.json"));
  for (const [subpath, target] of Object.entries<unknown>(manifest.exports)) {
    const label = `${name} ${subpath}`;
    // TypeScript finds each module's declarations beside it, so plain paths suffice.
    assert.equal(typeof target, "string", label);
    const file = String(target);
    assert.match(file, /^\.\/dist\/.+\.(?:d\.ts|js)$/, label);
    assert.ok(existsSync(join(directory, file)), `${label}: ${file}`);
    if (file.endsWith(".js")) {
      assert.ok(existsSync(join(directory, file.replace(/\.js$/, ".d.ts"))), label);
    }
    const resolved = require.resolve(name + subpath.slice(1));
    assert.ok(existsSync(resolved), `${label} resolves to ${resolved}`);
  }

  // Published code depends on vite, never on the vite-plus toolchain.
  for (const file of readdirSync(join(directory, "dist"), { recursive: true })) {
    const path = join(directory, "dist", String(file));
    if (statSync(path).isFile()) {
      assert.equal(readFileSync(path, "utf8").includes("vite-plus"), false, path);
    }
  }
  assert.equal("vite-plus" in { ...manifest.dependencies, ...manifest.peerDependencies }, false);
}

await buildArtifact({
  entry: "./entry.js",
  outDir: "./artifact",
  framework: "package-test",
  rendering: "buffered",
  backend: "quickjs",
});
assert.ok(existsSync("./artifact/server.js"));
assert.equal(JSON.parse(readFileSync("./artifact/fetchlet.json", "utf8")).handler, "handle");

// The `fetchlet` command is linked from the compiled bin. `fetchlet dev`
// builds, then starts the server, and returns the server's exit code once it
// exits; the server's command line passes through a shell on Windows, so the
// path of node, which may contain spaces, checks its quoting.
const fetchletManifest = JSON.parse(readFileSync(join(fetchletDirectory, "package.json"), "utf8"));
const bin = String(fetchletManifest.bin.fetchlet);
assert.match(bin, /^\.\/dist\/.+\.js$/, "fetchlet's bin");
assert.ok(existsSync("node_modules/.bin/fetchlet"), "the fetchlet command is linked");
rmSync("dev-build.txt", { force: true });
const command = spawnSync(
  process.execPath,
  [
    join(fetchletDirectory, bin),
    "dev",
    "--watch",
    "entry.js",
    "--build",
    "node dev-build.js",
    "--",
    process.execPath,
    "dev-server.js",
  ],
  {
    encoding: "utf8",
  },
);
assert.equal(command.status, 0, command.stdout + command.stderr);
assert.match(command.stdout, /server started after the build: built/);

// `fetchlet build` builds a TypeScript server module without Vite and copies
// the static directory into the artifact's client assets.
const built = spawnSync(
  process.execPath,
  [
    join(fetchletDirectory, bin),
    "build",
    "server.ts",
    "--backend",
    "quickjs",
    "--out",
    "cli-artifact",
    "--public",
    "public",
    "--assets",
  ],
  { encoding: "utf8" },
);
assert.equal(built.status, 0, built.stdout + built.stderr);
assert.deepEqual(JSON.parse(readFileSync("cli-artifact/fetchlet.json", "utf8")).functions, [
  "greet",
]);
assert.equal(readFileSync("cli-artifact/client/hello.txt", "utf8"), "static file\n");
assert.ok(existsSync("cli-artifact/assets.flpk"));

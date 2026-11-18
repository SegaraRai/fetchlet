// Runs inside the consumer project against the installed tarball.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArtifact } from "fetchlet/build";

const manifest = JSON.parse(readFileSync("./node_modules/fetchlet/package.json", "utf8"));

// The published manifest names compiled files and no workspace or catalog protocol.
assert.equal(JSON.stringify(manifest).includes("workspace:"), false);
assert.equal(JSON.stringify(manifest).includes("catalog:"), false);
for (const [subpath, target] of Object.entries(manifest.exports)) {
  // TypeScript finds each module's declarations beside it, so plain paths suffice.
  assert.equal(typeof target, "string", subpath);
  assert.match(target, /^\.\/dist\/.+\.(?:d\.ts|js)$/, subpath);
  assert.ok(existsSync(join("node_modules/fetchlet", target)), `${subpath}: ${String(target)}`);
  if (target.endsWith(".js")) {
    assert.ok(existsSync(join("node_modules/fetchlet", target.replace(/\.js$/, ".d.ts"))), subpath);
  }
  const resolved = fileURLToPath(import.meta.resolve("fetchlet" + subpath.slice(1)));
  assert.ok(existsSync(resolved), `${subpath} resolves to ${resolved}`);
}

// Published code depends on vite, never on the vite-plus toolchain.
for (const file of readdirSync("node_modules/fetchlet/dist", {
  recursive: true,
})) {
  const path = join("node_modules/fetchlet/dist", String(file));
  if (statSync(path).isFile()) {
    assert.equal(readFileSync(path, "utf8").includes("vite-plus"), false, path);
  }
}
assert.equal(
  "vite-plus" in
    {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    },
  false,
);

await buildArtifact({
  entry: "./entry.js",
  outDir: "./artifact",
  framework: "package-test",
  rendering: "buffered",
  backend: "quickjs",
});
assert.ok(existsSync("./artifact/server.js"));
assert.equal(JSON.parse(readFileSync("./artifact/fetchlet.json", "utf8")).handler, "handle");

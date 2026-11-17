// Runs inside the consumer project against the installed tarball.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArtifact } from "fetchlet/build";

const manifest = JSON.parse(readFileSync("./node_modules/fetchlet/package.json", "utf8"));

// The published manifest names compiled files and no workspace protocol.
assert.equal(JSON.stringify(manifest).includes("workspace:"), false);
for (const [subpath, target] of Object.entries(manifest.exports)) {
  for (const file of typeof target === "string" ? [target] : Object.values(target)) {
    assert.match(file, /^\.\/dist\/.+\.(?:d\.ts|js)$/, subpath);
    assert.ok(existsSync(join("node_modules/fetchlet", file)), `${subpath}: ${file}`);
  }
  // Type-only subpaths, such as fetchlet/nitro/types, have no module to load.
  if (typeof target === "string" || "default" in target) {
    const resolved = fileURLToPath(import.meta.resolve("fetchlet" + subpath.slice(1)));
    assert.ok(existsSync(resolved), `${subpath} resolves to ${resolved}`);
  }
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

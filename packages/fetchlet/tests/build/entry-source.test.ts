import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildArtifact } from "fetchlet/build";

test("an entry given as source builds without a file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-entry-source-"));
  try {
    const server = join(directory, "server");
    mkdirSync(server);
    writeFileSync(join(server, "app.js"), 'export const greeting = "from disk";\n');
    await buildArtifact({
      entry: {
        source: `
          import { greeting } from "./app.js";
          export const handle = () => greeting + " and memory";
        `,
        resolveDir: server,
      },
      outDir: join(directory, "out"),
    });
    // The relative import resolved from resolveDir, and no entry file was written.
    assert.deepEqual(readdirSync(server), ["app.js"]);
    assert.ok(existsSync(join(directory, "out/server.js")));
    assert.match(readFileSync(join(directory, "out/server.js"), "utf8"), /from disk/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

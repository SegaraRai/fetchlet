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

import { buildArtifact } from "fetchlet/build";
import { expect, test } from "vite-plus/test";

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
    expect(readdirSync(server)).toStrictEqual(["app.js"]);
    expect(existsSync(join(directory, "out/server.js"))).toBeTruthy();
    expect(readFileSync(join(directory, "out/server.js"), "utf8")).toMatch(/from disk/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

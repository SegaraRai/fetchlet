// Writes the asset archive that fetchlet-http's tests read, so the Rust reader
// is checked against the Node writer: `vp run refresh:asset-archive`.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";
import { writeAssetArchive } from "fetchlet/build";

const out = resolve(root, "crates/fetchlet-http/tests/fixtures/embedded/assets.flpk");
const client = mkdtempSync(join(tmpdir(), "fetchlet-asset-archive-"));

// Bytes that Brotli cannot shrink, the same on every run.
function incompressible(size: number): Buffer {
  const chunks: Buffer[] = [];
  let block = Buffer.from("fetchlet");
  for (let length = 0; length < size; length += block.length) {
    block = createHash("sha256").update(block).digest();
    chunks.push(block);
  }
  return Buffer.concat(chunks).subarray(0, size);
}

const files: Record<string, string | Buffer> = {
  "index.html": "<!doctype html><title>home</title>" + "<p>fetchlet</p>".repeat(64),
  "docs/index.html": "<!doctype html><title>docs</title>" + "<p>docs</p>".repeat(64),
  "_app/immutable/app.js": "export const message = 'fetchlet';\n".repeat(64),
  "image.bin": incompressible(1000),
  "old.html": "replaced by a redirect",
  "café.txt": "unicode path",
};

try {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(client, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  const summary = await writeAssetArchive({
    directory: client,
    out,
    respond({ path, headers }) {
      if (path.startsWith("/_app/immutable/")) {
        headers.set("cache-control", "public, max-age=31536000, immutable");
      }
      if (path === "/old.html") {
        return new Response(null, {
          status: 301,
          headers: { location: "/" },
        });
      }
      if (path === "/café.txt") {
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
      }
      return headers;
    },
  });
  console.log(`[asset-archive] ${out}: ${summary.entries} entries`);
} finally {
  rmSync(client, { recursive: true, force: true });
}

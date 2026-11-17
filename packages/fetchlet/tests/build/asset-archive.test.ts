// writeAssetArchive's choices that the Rust tests do not see: what it refuses,
// what it shares and how it merges Vary. docs/asset-archive.md has the format.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";

import { archiveArtifactAssets, writeAssetArchive, type AssetResponder } from "fetchlet/build";

interface Entry {
  path: string;
  status: number;
  brotli: boolean;
  headers: [string, string][];
  dataOffset: bigint;
  body: Buffer;
}

/** Read an archive back, following docs/asset-archive.md. */
function readArchive(archive: Buffer): Entry[] {
  assert.equal(archive.subarray(0, 4).toString("latin1"), "FLPK");
  assert.equal(archive.readUInt16LE(4), 1);
  const entryCount = archive.readUInt32LE(8);
  const entryOffset = Number(archive.readBigUInt64LE(24));
  const setOffset = Number(archive.readBigUInt64LE(32));
  const pairOffset = Number(archive.readBigUInt64LE(40));
  const stringOffset = Number(archive.readBigUInt64LE(48));
  const dataOffset = Number(archive.readBigUInt64LE(64));
  const string = (offset: number, length: number) =>
    archive.toString("utf8", stringOffset + offset, stringOffset + offset + length);
  const entries: Entry[] = [];
  for (let index = 0; index < entryCount; index++) {
    const at = entryOffset + index * 64;
    const set = setOffset + archive.readUInt32LE(at + 32) * 8;
    const headers: [string, string][] = [];
    for (let pair = 0; pair < archive.readUInt32LE(set + 4); pair++) {
      const p = pairOffset + (archive.readUInt32LE(set) + pair) * 16;
      headers.push([
        string(archive.readUInt32LE(p), archive.readUInt32LE(p + 4)),
        string(archive.readUInt32LE(p + 8), archive.readUInt32LE(p + 12)),
      ]);
    }
    const brotli = (archive.readUInt16LE(at + 38) & 1) === 1;
    const start = dataOffset + Number(archive.readBigUInt64LE(at + 8));
    const stored = archive.subarray(start, start + Number(archive.readBigUInt64LE(at + 16)));
    entries.push({
      path: string(archive.readUInt32LE(at), archive.readUInt32LE(at + 4)),
      status: archive.readUInt16LE(at + 36),
      brotli,
      headers,
      dataOffset: archive.readBigUInt64LE(at + 8),
      body: brotli ? brotliDecompressSync(stored) : Buffer.from(stored),
    });
  }
  return entries;
}

async function archiveOf(
  files: Record<string, string>,
  respond?: AssetResponder,
): Promise<{ entries: Entry[]; bytes: Buffer }> {
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-asset-test-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, "client", name)), { recursive: true });
      writeFileSync(join(directory, "client", name), contents);
    }
    const out = join(directory, "assets.flpk");
    await writeAssetArchive({
      directory: join(directory, "client"),
      out,
      ...(respond ? { respond } : {}),
    });
    const bytes = readFileSync(out);
    return { entries: readArchive(bytes), bytes };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const text = "fetchlet ".repeat(100);

test("entries are sorted by path bytes and identical bodies are stored once", async () => {
  const { entries } = await archiveOf({ "b.txt": text, "a.txt": text, "Z.txt": "other" });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["/Z.txt", "/a.txt", "/b.txt"],
  );
  const [, a, b] = entries;
  assert.equal(a!.dataOffset, b!.dataOffset);
  assert.equal(a!.body.toString(), text);
  assert.ok(a!.brotli);
});

test("Brotli entries vary on Accept-Encoding, merged into a stored Vary", async () => {
  const { entries } = await archiveOf(
    { "a.txt": text, "b.txt": text + "!", "tiny.txt": "x" },
    ({ path, headers }) => {
      if (path === "/b.txt") headers.set("vary", "origin");
      return headers;
    },
  );
  const vary = (path: string) =>
    entries.find((entry) => entry.path === path)!.headers.find(([name]) => name === "vary")?.[1];
  assert.equal(vary("/a.txt"), "accept-encoding");
  assert.equal(vary("/b.txt"), "origin, accept-encoding");
  // A body Brotli does not shrink is stored as it is, without Vary.
  const tiny = entries.find((entry) => entry.path === "/tiny.txt")!;
  assert.equal(tiny.brotli, false);
  assert.equal(vary("/tiny.txt"), undefined);
});

test("a Response replaces the file with its status, headers and body", async () => {
  const { entries } = await archiveOf(
    { "page.html": "file" },
    () => new Response("generated", { status: 410, headers: { "x-reason": "gone" } }),
  );
  const [page] = entries;
  assert.equal(page!.status, 410);
  assert.equal(page!.body.toString(), "generated");
  assert.deepEqual(page!.headers, [
    ["content-type", "text/plain;charset=UTF-8"],
    ["x-reason", "gone"],
  ]);
});

test("headers the server derives are refused", async () => {
  for (const name of ["content-length", "content-encoding", "etag", "content-range"]) {
    await assert.rejects(
      archiveOf({ "a.txt": "a" }, ({ headers }) => {
        headers.set(name, "1");
        return headers;
      }),
      new RegExp(`sets ${name}`),
    );
  }
});

test("archiveArtifactAssets writes assets.flpk and names it in fetchlet.json", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-asset-artifact-"));
  try {
    mkdirSync(join(directory, "client"));
    writeFileSync(join(directory, "client", "index.html"), "<p>home</p>");
    writeFileSync(
      join(directory, "fetchlet.json"),
      JSON.stringify({ server: "server.js", client: "client" }),
    );
    const summary = await archiveArtifactAssets({ outDir: directory });
    assert.equal(summary.entries, 2);
    const manifest = JSON.parse(readFileSync(join(directory, "fetchlet.json"), "utf8"));
    assert.equal(manifest.assets, "assets.flpk");
    const paths = readArchive(readFileSync(join(directory, "assets.flpk"))).map(
      (entry) => entry.path,
    );
    assert.deepEqual(paths, ["/", "/index.html"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Each path an archive answers: the status, and the Location of a redirect. */
async function routesOf(
  files: string[],
  routes?: Parameters<typeof writeAssetArchive>[0]["routes"],
): Promise<Record<string, string>> {
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-asset-routes-"));
  try {
    for (const name of files) {
      mkdirSync(dirname(join(directory, "client", name)), { recursive: true });
      writeFileSync(join(directory, "client", name), name);
    }
    const out = join(directory, "assets.flpk");
    await writeAssetArchive({
      directory: join(directory, "client"),
      out,
      ...(routes ? { routes } : {}),
    });
    const bytes = readFileSync(out);
    const entryOffset = Number(bytes.readBigUInt64LE(24));
    return Object.fromEntries(
      readArchive(bytes).map((entry, index) => {
        const location = entry.headers.find(([name]) => name === "location")?.[1];
        const keepsQuery = (bytes.readUInt16LE(entryOffset + index * 64 + 38) & 2) === 2;
        if (location) assert.ok(keepsQuery, `${entry.path} keeps the query`);
        return [entry.path, location ? `${entry.status} ${location}` : entry.body.toString()];
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const pages = ["index.html", "docs/index.html", "about.html", "app.js"];

test("the default routes serve what ServeDir serves", async () => {
  assert.deepEqual(await routesOf(pages), {
    "/": "index.html",
    "/about.html": "about.html",
    "/app.js": "app.js",
    "/docs": "308 /docs/",
    "/docs/": "docs/index.html",
    "/docs/index.html": "docs/index.html",
    "/index.html": "index.html",
  });
});

test("trailingSlash never with stripped extensions follows SvelteKit", async () => {
  assert.deepEqual(await routesOf(pages, { trailingSlash: "never", htmlExtension: "strip" }), {
    "/": "index.html",
    "/about": "about.html",
    "/about.html": "308 /about",
    "/about/": "308 /about",
    "/app.js": "app.js",
    "/docs": "docs/index.html",
    "/docs/": "308 /docs",
    "/docs/index.html": "308 /docs",
    "/index.html": "308 /",
  });
});

test("trailingSlash always with stripped extensions puts pages under a slash", async () => {
  const routes = await routesOf(pages, { trailingSlash: "always", htmlExtension: "strip" });
  assert.equal(routes["/about/"], "about.html");
  assert.equal(routes["/about"], "308 /about/");
  assert.equal(routes["/about.html"], "308 /about/");
});

test("trailingSlash ignore serves both forms", async () => {
  const routes = await routesOf(pages, { trailingSlash: "ignore", htmlExtension: "strip" });
  assert.equal(routes["/docs"], "docs/index.html");
  assert.equal(routes["/docs/"], "docs/index.html");
  assert.equal(routes["/about"], "about.html");
  assert.equal(routes["/about/"], "about.html");
});

test("two files at one path are refused, and a file wins over a redirect", async () => {
  await assert.rejects(
    routesOf(["about.html", "about/index.html"], {
      trailingSlash: "never",
      htmlExtension: "strip",
    }),
    /\/about is served twice/,
  );
  // x.html redirects /x.html to /x, but x.html.html is served at /x.html.
  const routes = await routesOf(["x.html", "x.html.html"], {
    trailingSlash: "never",
    htmlExtension: "strip",
  });
  assert.equal(routes["/x"], "x.html");
  assert.equal(routes["/x.html"], "x.html.html");
});

test("dot-named build metadata is left out, .well-known is kept", async () => {
  const routes = await routesOf([".vite/manifest.json", ".well-known/security.txt", "app.js"]);
  assert.deepEqual(Object.keys(routes).sort(), ["/.well-known/security.txt", "/app.js"]);
});

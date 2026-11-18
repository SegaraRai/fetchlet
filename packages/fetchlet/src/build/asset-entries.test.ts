import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { contentType, defaultAssetInclude, directoryAssets, redirect } from "./asset-entries.ts";

describe("contentType", () => {
  test.each([
    ["/app.js", "text/javascript; charset=utf-8"],
    ["/app.mjs", "text/javascript; charset=utf-8"],
    ["/style.CSS", "text/css; charset=utf-8"],
    ["/index.html", "text/html; charset=utf-8"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/module.wasm", "application/wasm"],
    ["/font.woff2", "font/woff2"],
    ["/a.b/archive.tar.gz", "application/octet-stream"],
  ])("%s is %s", (path, type) => {
    expect(contentType(path)).toBe(type);
  });

  test("names without an extension, and dot directories, fall back to bytes", () => {
    expect(contentType("/LICENSE")).toBe("application/octet-stream");
    expect(contentType("/.well-known/security")).toBe("application/octet-stream");
    expect(contentType("/assets.js/data")).toBe("application/octet-stream");
  });

  test("a dot-named file is typed by what follows its last dot", () => {
    expect(contentType("/.config.json")).toBe("application/json");
    expect(contentType("/file.")).toBe("application/octet-stream");
  });
});

describe("defaultAssetInclude", () => {
  test("leaves out dot-named files and directories except .well-known", () => {
    expect(defaultAssetInclude({ path: "/.vite", directory: true })).toBe(false);
    expect(defaultAssetInclude({ path: "/assets/.DS_Store", directory: false })).toBe(false);
    expect(defaultAssetInclude({ path: "/.well-known", directory: true })).toBe(true);
    expect(defaultAssetInclude({ path: "/.well-known/security.txt", directory: false })).toBe(true);
    expect(defaultAssetInclude({ path: "/assets/app.js", directory: false })).toBe(true);
  });

  test("decides by the last segment only", () => {
    expect(defaultAssetInclude({ path: "/.well-known/.hidden", directory: false })).toBe(false);
    expect(defaultAssetInclude({ path: "/a.b/file", directory: false })).toBe(true);
  });
});

describe("redirect", () => {
  test("is a permanent redirect that keeps the query by default", () => {
    expect(redirect("/old", "/new")).toStrictEqual({
      path: "/old",
      status: 308,
      headers: { location: "/new" },
      appendQuery: true,
    });
  });

  test("takes another redirect status", () => {
    expect(redirect("/old", "https://example.test/", 302).status).toBe(302);
  });
});

describe("directoryAssets", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
    directory = undefined;
  });

  function files(paths: Record<string, string>): string {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-assets-"));
    for (const [path, text] of Object.entries(paths)) {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return directory;
  }

  test("an empty directory has no entries", async () => {
    expect(await directoryAssets(files({}))).toStrictEqual([]);
  });

  test("entries follow file name order, and each file carries its content type", async () => {
    const entries = await directoryAssets(files({ "b.css": "", "a.js": "", "c/d.svg": "" }));
    expect(entries.map((entry) => entry.path)).toStrictEqual(["/a.js", "/b.css", "/c/d.svg"]);
    expect(entries.map((entry) => new Headers(entry.headers).get("content-type"))).toStrictEqual([
      "text/javascript; charset=utf-8",
      "text/css; charset=utf-8",
      "image/svg+xml",
    ]);
  });

  test("respond receives the route, the file and its size, and null leaves it out", async () => {
    const seen: { path: string; size: number }[] = [];
    const entries = await directoryAssets(files({ "keep.txt": "12345", "skip.txt": "" }), {
      respond({ path, size, headers }) {
        seen.push({ path, size });
        return path === "/skip.txt" ? null : headers;
      },
    });
    expect(seen).toStrictEqual([
      { path: "/keep.txt", size: 5 },
      { path: "/skip.txt", size: 0 },
    ]);
    expect(entries.map((entry) => entry.path)).toStrictEqual(["/keep.txt"]);
  });

  test("a cache rule matches the route, not the file name", async () => {
    const entries = await directoryAssets(files({ "docs/index.html": "" }), {
      cache: [{ prefix: "/docs/", cacheControl: "no-cache" }],
    });
    const page = entries.find((entry) => entry.path === "/docs/");
    expect(new Headers(page?.headers).get("cache-control")).toBe("no-cache");
  });
});

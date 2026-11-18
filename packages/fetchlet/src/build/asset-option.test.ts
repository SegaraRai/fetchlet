import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import type { AssetEntry } from "./asset-archive.ts";
import { redirect } from "./asset-entries.ts";
import { archiveArtifactAssets, frameworkAssets, type AssetContext } from "./asset-option.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

function files(paths: Record<string, string>): string {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-asset-option-"));
  for (const [path, text] of Object.entries(paths)) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return directory;
}

function context(root: string): AssetContext {
  return {
    directory: root,
    defaults: () => {
      throw new Error("frameworkAssets supplies its own defaults");
    },
  };
}

const paths = (entries: Iterable<AssetEntry>) => [...entries].map((entry) => entry.path);
/** The paths that serve a file, leaving out redirects. */
const served = (entries: Iterable<AssetEntry>) =>
  [...entries].filter((entry) => entry.status === undefined).map((entry) => entry.path);
const cacheControl = (entries: Iterable<AssetEntry>, path: string) =>
  new Headers([...entries].find((entry) => entry.path === path)?.headers).get("cache-control");

describe("frameworkAssets", () => {
  test("true archives the directory with the framework's routes", async () => {
    const root = files({
      "about.html": "",
      "index.html": "",
    });
    const entries = await frameworkAssets(true, {
      routes: {
        htmlExtension: "strip",
        trailingSlash: "never",
      },
    })(context(root));
    expect(served(entries)).toStrictEqual(["/about", "/"]);
  });

  test("the app's routes replace the framework's", async () => {
    const root = files({
      "about.html": "",
    });
    const entries = await frameworkAssets(
      { routes: { htmlExtension: "keep" } },
      { routes: { htmlExtension: "strip" } },
    )(context(root));
    expect(paths(entries)).toStrictEqual(["/about.html"]);
  });

  test("the app's cache rule wins over the framework's for the same prefix", async () => {
    const root = files({
      "assets/app.js": "",
      "assets/other.js": "",
    });
    const entries = await frameworkAssets(
      { cache: [{ prefix: "/assets/", cacheControl: "no-store" }] },
      { cache: [{ prefix: "/assets/", cacheControl: "immutable" }] },
    )(context(root));
    expect(cacheControl(entries, "/assets/app.js")).toBe("no-store");
  });

  test("a longer framework prefix still wins over a shorter app prefix", async () => {
    const root = files({
      "assets/app.js": "",
    });
    const entries = await frameworkAssets(
      { cache: [{ prefix: "/", cacheControl: "no-cache" }] },
      { cache: [{ prefix: "/assets/", cacheControl: "immutable" }] },
    )(context(root));
    expect(cacheControl(entries, "/assets/app.js")).toBe("immutable");
  });

  test("the app's include receives the framework's decision as its default", async () => {
    const root = files({
      "keep.txt": "",
      "server/secret.txt": "",
    });
    const seen: [string, boolean][] = [];
    const entries = await frameworkAssets(
      {
        include(entry, defaults) {
          seen.push([entry.path, defaults]);
          return defaults;
        },
      },
      {
        include: (entry, defaults) => defaults && entry.path !== "/server",
      },
    )(context(root));
    expect(seen).toContainEqual(["/server", false]);
    expect(paths(entries)).toStrictEqual(["/keep.txt"]);
  });

  test("settings entries come after the directory's", async () => {
    const root = files({
      "a.txt": "",
    });
    const entries = await frameworkAssets({ entries: [redirect("/old", "/a.txt")] })(context(root));
    expect(paths(entries)).toStrictEqual(["/a.txt", "/old"]);
  });

  test("a function receives the directory and defaults with the framework's settings", async () => {
    const root = files({
      "about.html": "",
    });
    const entries = await frameworkAssets(
      async ({ directory: given, defaults }) => {
        expect(given).toBe(root);
        return [...(await defaults()), redirect("/x", "/about")];
      },
      {
        routes: {
          htmlExtension: "strip",
          trailingSlash: "never",
        },
      },
    )(context(root));
    expect(served(entries)).toStrictEqual(["/about"]);
    expect(paths(entries).at(-1)).toBe("/x");
  });

  test("a function's own options override the framework's routes", async () => {
    const root = files({
      "about.html": "",
    });
    const entries = await frameworkAssets(
      ({ defaults }) =>
        defaults({
          routes: {
            htmlExtension: "keep",
          },
        }),
      {
        routes: {
          htmlExtension: "strip",
        },
      },
    )(context(root));
    expect(paths(entries)).toStrictEqual(["/about.html"]);
  });
});

describe("archiveArtifactAssets", () => {
  test("refuses an artifact whose manifest names no client directory", async () => {
    const root = files({
      "fetchlet.json": JSON.stringify({ server: "server.js" }),
    });
    await expect(archiveArtifactAssets({ outDir: root })).rejects.toThrow(
      /names no client directory/,
    );
  });

  test("keeps the manifest's other fields when it adds the archive", async () => {
    const root = files({
      "fetchlet.json": JSON.stringify({ server: "server.js", client: "client" }),
      "client/index.html": "<p>hi</p>",
    });
    const summary = await archiveArtifactAssets({ outDir: root });
    expect(summary.entries).toBeGreaterThan(0);
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(root, "fetchlet.json"), "utf8"))).toStrictEqual({
      server: "server.js",
      client: "client",
      assets: "assets.flpk",
    });
  });
});

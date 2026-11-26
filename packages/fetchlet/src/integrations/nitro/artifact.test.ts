import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Nitro } from "nitropack/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import { writeArtifact } from "./artifact.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-nitro-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function nitro(options: { fetchlet?: object; framework?: string; publicAssets?: object[] } = {}) {
  return {
    options: {
      fetchlet: options.fetchlet,
      framework: {
        name: options.framework ?? "",
      },
      output: {
        dir: directory,
        serverDir: join(directory, ".nitro", "server"),
      },
      publicAssets: options.publicAssets ?? [],
    },
  } as unknown as Nitro;
}

const built = () => vi.mocked(buildArtifact).mock.lastCall![0];

describe("fetchlet/nitro writeArtifact", () => {
  test("replaces nitro.json and bundles Nitro's server with the environment module", async () => {
    writeFileSync(join(directory, "nitro.json"), "{}");
    await writeArtifact(nitro());
    expect(existsSync(join(directory, "nitro.json"))).toBe(false);
    expect(built()).toMatchObject({
      outDir: directory,
      framework: "nitro",
      rendering: "buffered",
      backend: "portable",
      intl: {},
      entry: {
        resolveDir: join(directory, ".nitro", "server"),
      },
    });
    expect(built().plugins?.map((plugin) => plugin.name)).toStrictEqual([
      "fetchlet:nitro-environment",
    ]);
    expect(built()).not.toHaveProperty("assets");
  });

  test("the entry imports the environment module, which aliases globalThis.__env__ to process.env", async () => {
    await writeArtifact(nitro());
    const plugin = built().plugins![0] as unknown as {
      resolveId(id: string): string | undefined;
      load(id: string): string | undefined;
    };
    const source = (built().entry as { source: string }).source;
    const id = JSON.parse(/import ("\\u0000fetchlet:[^"]+");/.exec(source)![1]!) as string;
    expect(plugin.resolveId(id)).toBe(id);
    expect(plugin.resolveId("other")).toBeUndefined();
    expect(plugin.load(id)).toContain("globalThis.__env__ = process.env");
  });

  test("takes the framework name and the app's fetchlet options", async () => {
    await writeArtifact(
      nitro({
        framework: "nuxt",
        fetchlet: {
          backend: "v8",
          intl: { locales: ["fr"] },
        },
      }),
    );
    expect(built()).toMatchObject({
      framework: "nuxt",
      backend: "v8",
      intl: {
        locales: ["fr"],
      },
    });
  });

  test("assets cache the public directories that set maxAge", async () => {
    await writeArtifact(
      nitro({
        fetchlet: { assets: true },
        publicAssets: [
          { dir: "a", baseURL: "/_nuxt", maxAge: 31536000 },
          { dir: "b", baseURL: "/static/", maxAge: 60 },
          { dir: "c", maxAge: 3600 },
          { dir: "d", baseURL: "/plain" },
        ],
      }),
    );
    expect(built().assets).toStrictEqual({
      assets: true,
      defaults: {
        cache: [
          { prefix: "/_nuxt/", cacheControl: "public, max-age=31536000, immutable" },
          { prefix: "/static/", cacheControl: "public, max-age=60, immutable" },
          { prefix: "/", cacheControl: "public, max-age=3600, immutable" },
        ],
      },
    });
  });
});

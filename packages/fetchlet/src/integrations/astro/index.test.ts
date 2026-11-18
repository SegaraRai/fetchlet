import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import fetchletAdapter, { type FetchletAstroOptions } from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

beforeEach(() => {
  vi.mocked(buildArtifact).mockClear();
});

type Hook = (options: unknown) => unknown;
const rootPath = join(process.cwd(), "astro-app");
const root = pathToFileURL(rootPath + "/");
const cacheDir = new URL("./node_modules/.astro/", root);

/** Run the adapter's hooks as Astro does, with the config Astro would resolve. */
async function run(
  options: FetchletAstroOptions = {},
  config: { trailingSlash?: string; format?: string } = {},
) {
  const { hooks } = fetchletAdapter(options);
  const updateConfig = vi.fn();
  const setAdapter = vi.fn();
  (hooks["astro:config:setup"] as Hook)({
    config: {
      root,
      cacheDir,
    },
    updateConfig,
  });
  const update = updateConfig.mock.lastCall![0];
  (hooks["astro:config:done"] as Hook)({
    config: {
      build: { ...update.build, assets: "_astro", format: config.format ?? "directory" },
      trailingSlash: config.trailingSlash ?? "ignore",
    },
    setAdapter,
  });
  await (hooks["astro:build:done"] as Hook)({});
  return {
    update,
    adapter: setAdapter.mock.lastCall![0],
    options: vi.mocked(buildArtifact).mock.lastCall![0],
  };
}

describe("fetchlet/astro", () => {
  test("writes the client under the output and the server into Astro's cache", async () => {
    const { update } = await run({ out: "dist" });
    expect(update.outDir.href).toBe(pathToFileURL(join(rootPath, "dist") + "/").href);
    expect(update.build.client.href).toBe(
      pathToFileURL(join(rootPath, "dist", "client") + "/").href,
    );
    expect(update.build.server.href).toBe(new URL("./fetchlet/server/", cacheDir).href);
    expect(update.build.serverEntry).toBe("entry.mjs");
  });

  test("registers the server adapter without static output", async () => {
    const { adapter } = await run();
    expect(adapter).toMatchObject({
      name: "fetchlet/astro",
      serverEntrypoint: "fetchlet/astro/server",
      supportedAstroFeatures: {
        serverOutput: "stable",
        staticOutput: "unsupported",
      },
    });
  });

  test("bundles the server entry with DateTimeFormat for Astro", async () => {
    const { options } = await run({
      backend: "v8",
    });
    expect(options).toMatchObject({
      entry: fileURLToPath(new URL("./fetchlet/server/entry.mjs", cacheDir)),
      outDir: join(rootPath, "build"),
      framework: "astro",
      rendering: "streaming",
      requirements: ["Intl.DateTimeFormat"],
      backend: "v8",
    });
    expect(options).not.toHaveProperty("assets");
  });

  test.each([
    ["directory", "keep"],
    ["file", "strip"],
  ])(
    "assets with build.format %s %s .html and cache build.assets",
    async (format, htmlExtension) => {
      const { options } = await run(
        {
          assets: true,
        },
        {
          format,
          trailingSlash: "never",
        },
      );
      expect(options.assets).toStrictEqual({
        assets: true,
        defaults: {
          cache: [
            {
              prefix: "/_astro/",
              cacheControl: expect.stringContaining("immutable"),
            },
          ],
          routes: {
            trailingSlash: "never",
            htmlExtension,
          },
        },
      });
    },
  );
});

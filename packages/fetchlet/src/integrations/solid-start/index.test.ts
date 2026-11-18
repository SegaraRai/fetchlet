import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import fetchletSolidStart from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-solid-start-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;

describe("fetchlet/solid-start", () => {
  test("bundles every SSR dependency with Solid's server conditions", () => {
    const plugin = fetchletSolidStart();
    const config = hook(plugin, "config").call({}) as { environments: Record<string, any> };
    expect(config.environments.ssr.resolve.noExternal).toBe(true);
    const ssr = hook(plugin, "configEnvironment").call({}, "ssr", {
      build: {
        outDir: "x",
      },
    }) as {
      resolve: {
        conditions: string[];
      };
    };
    expect(ssr.resolve.conditions.slice(0, 3)).toStrictEqual(["solid", "worker", "generic"]);
    expect(hook(plugin, "configEnvironment").call({}, "client", {})).toBeUndefined();
  });

  test("writeBundle uses the SSR output directory and sets h3's request fields", async () => {
    writeFileSync(join(directory, "entry.js"), "");
    const plugin = fetchletSolidStart({
      outDir: "build",
      assets: true,
    });
    hook(plugin, "configResolved").call(
      {},
      {
        root: directory,
      },
    );
    hook(plugin, "configEnvironment").call({}, "ssr", {
      build: {
        outDir: directory,
      },
    });
    await hook(plugin, "writeBundle").call(
      {},
      {},
      {
        css: {
          type: "asset",
          fileName: "style.css",
        },
        entry: {
          type: "chunk",
          fileName: "entry.js",
          isEntry: true,
        },
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options).toMatchObject({
      outDir: join(directory, "build"),
      framework: "solid-start",
      asyncContext: "serialized",
      entry: {
        resolveDir: directory,
      },
      assets: {
        assets: true,
        defaults: {
          cache: [
            {
              prefix: "/_build/assets/",
              cacheControl: expect.stringContaining("immutable"),
            },
          ],
        },
      },
    });
    const source = (options.entry as { source: string }).source;
    expect(source).toContain("entry.js");
    expect(source).toMatch(/ip: \{ value: context\.clientAddress/);
    expect(source).toContain('name: "fetchlet"');
  });

  test("writeBundle fails when the entry chunk is missing", async () => {
    const plugin = fetchletSolidStart();
    await expect(
      hook(plugin, "writeBundle").call(
        {},
        {
          dir: directory,
        },
        {
          entry: {
            type: "chunk",
            fileName: "gone.js",
            isEntry: true,
          },
        },
      ),
    ).rejects.toThrow(/found no server entry/);
  });
});

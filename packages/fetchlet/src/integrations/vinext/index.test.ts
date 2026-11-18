import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { archiveArtifactAssets } from "../../build/asset-option.ts";
import { buildArtifact } from "../../build/index.ts";
import fetchletVinext, { type FetchletVinextOptions } from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({
  buildArtifact: vi.fn(),
}));
vi.mock(import("../../build/asset-option.ts"), () => ({
  archiveArtifactAssets: vi.fn(),
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-vinext-"));
  vi.mocked(buildArtifact).mockClear();
  vi.mocked(archiveArtifactAssets).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;

async function buildApp(options: FetchletVinextOptions = {}) {
  const plugin = fetchletVinext(options);
  hook(plugin, "configResolved").call(
    {},
    {
      root: directory,
    },
  );
  const builder = {
    environments: {
      rsc: {
        config: {
          build: {
            outDir: "dist/server",
          },
        },
      },
    },
  };
  await (plugin.buildApp as { handler: Hook }).handler.call({}, builder);
}

describe("fetchlet/vinext", () => {
  test("puts the client under outDir and bundles the servers with Web conditions", () => {
    const configEnvironment = hook(fetchletVinext({ outDir: "out" }), "configEnvironment");
    expect(configEnvironment.call({}, "client")).toStrictEqual({
      build: {
        outDir: join("out", "client"),
      },
    });
    for (const name of ["rsc", "ssr"]) {
      expect(configEnvironment.call({}, name)).toStrictEqual({
        resolve: {
          conditions: ["workerd", "edge-light", "worker"],
          noExternal: true,
        },
      });
    }
    expect(configEnvironment.call({}, "other")).toBeUndefined();
  });

  test("builds the RSC server with the Node shims and request context", async () => {
    mkdirSync(join(directory, "dist", "server"), { recursive: true });
    writeFileSync(join(directory, "dist", "server", "index.js"), "");
    await buildApp({ backend: "v8" });
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options).toMatchObject({
      outDir: join(directory, "build"),
      framework: "vinext",
      rendering: "streaming",
      asyncContext: "serialized",
      conditions: ["workerd", "edge-light", "worker"],
      define: {
        "process.env": "{}",
      },
      backend: "v8",
      entry: {
        resolveDir: join(directory, "dist", "server"),
        source: expect.stringContaining("runWithRequestContext(requestContext"),
      },
    });
    expect(options.plugins?.map((plugin) => plugin.name)).toStrictEqual([
      "fetchlet/vinext:node-compat",
    ]);
    expect(archiveArtifactAssets).not.toHaveBeenCalled();
  });

  test("assets archive the built client with _next/static cached", async () => {
    mkdirSync(join(directory, "dist", "server"), { recursive: true });
    writeFileSync(join(directory, "dist", "server", "index.js"), "");
    await buildApp({ assets: true });
    expect(vi.mocked(buildArtifact).mock.lastCall![0]).not.toHaveProperty("assets");
    expect(archiveArtifactAssets).toHaveBeenCalledWith({
      outDir: join(directory, "build"),
      assets: {
        assets: true,
        defaults: {
          cache: [
            {
              prefix: "/_next/static/",
              cacheControl: expect.stringContaining("immutable"),
            },
          ],
        },
      },
    });
  });

  test("fails without the App Router server build", async () => {
    await expect(buildApp()).rejects.toThrow(/found no App Router server build/);
    expect(buildArtifact).not.toHaveBeenCalled();
  });
});

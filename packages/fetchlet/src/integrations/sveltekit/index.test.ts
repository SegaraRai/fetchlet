import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Builder } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import fetchletAdapter, { type FetchletSvelteKitOptions } from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-sveltekit-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function adapt(options: FetchletSvelteKitOptions = {}) {
  const builder = {
    config: {
      appDir: "_app",
    },
    getBuildDirectory: (name: string) => join(directory, ".svelte-kit", name),
    writeServer: vi.fn(),
    generateServerInstance: vi.fn(),
    writeClient: vi.fn(),
    writePrerendered: vi.fn(),
  };
  await fetchletAdapter({
    out: join(directory, "build"),
    ...options,
  }).adapt(builder as unknown as Builder);
  return {
    builder,
    options: vi.mocked(buildArtifact).mock.lastCall![0],
  };
}

describe("fetchlet/sveltekit", () => {
  test("refuses an unknown rendering profile", () => {
    expect(() => fetchletAdapter({ rendering: "streaming" as never })).toThrow(
      'Unknown rendering profile "streaming"',
    );
  });

  test("writes the client and prerendered pages beside the artifact", async () => {
    const { builder, options } = await adapt();
    const client = join(directory, "build", "client");
    expect(builder.writeClient).toHaveBeenCalledWith(client);
    expect(builder.writePrerendered).toHaveBeenCalledWith(client);
    expect(options).toMatchObject({
      outDir: join(directory, "build"),
      framework: "sveltekit",
      rendering: "synchronous",
      backend: "portable",
      intl: {},
      entry: {
        resolveDir: join(directory, ".svelte-kit", "fetchlet"),
        source: expect.stringContaining("server.respond"),
      },
    });
    expect(options).not.toHaveProperty("assets");
  });

  test("synchronous rendering replaces AsyncLocalStorage, async rendering serializes it", async () => {
    const { options: synchronous } = await adapt();
    expect(synchronous.asyncContext).toBeUndefined();
    expect(synchronous.plugins?.map((plugin) => plugin.name)).toStrictEqual([
      "fetchlet-synchronous-rendering",
    ]);
    const { options: async } = await adapt({
      rendering: "async",
    });
    expect(async).toMatchObject({
      asyncContext: "serialized",
      rendering: "async",
    });
    expect(async.plugins).toBeUndefined();
  });

  test("assets cache the app directory's immutable files and strip .html", async () => {
    const { options } = await adapt({
      assets: true,
      backend: "v8",
    });
    expect(options.backend).toBe("v8");
    expect(options.assets).toStrictEqual({
      assets: true,
      defaults: {
        cache: [
          {
            prefix: "/_app/immutable/",
            cacheControl: expect.stringContaining("immutable"),
          },
        ],
        routes: {
          trailingSlash: "never",
          htmlExtension: "strip",
        },
      },
    });
  });
});

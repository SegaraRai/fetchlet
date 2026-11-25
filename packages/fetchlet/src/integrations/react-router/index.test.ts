import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import { fetchletPreset, type FetchletPresetOptions } from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

beforeEach(() => {
  vi.mocked(buildArtifact).mockClear();
});

type Hook = (...args: unknown[]) => unknown;

async function buildEnd(options: FetchletPresetOptions = {}) {
  const config = (fetchletPreset(options).reactRouterConfig as Hook)({}) as { buildEnd: Hook };
  await config.buildEnd({
    reactRouterConfig: {
      buildDirectory: "/app/build",
      serverBuildFile: "index.js",
    },
  });
  return vi.mocked(buildArtifact).mock.lastCall![0];
}

describe("fetchlet/react-router", () => {
  test("requires one server bundle with SSR", () => {
    const resolved = fetchletPreset().reactRouterConfigResolved as Hook;
    expect(() => resolved({ reactRouterConfig: { ssr: true } })).not.toThrow();
    expect(() => resolved({ reactRouterConfig: { ssr: false } })).toThrow(/requires ssr: true/);
    expect(() => resolved({ reactRouterConfig: { ssr: true, serverBundles: () => "a" } })).toThrow(
      /one server bundle/,
    );
  });

  test("sets SSR with an ESM server build", () => {
    const config = (fetchletPreset().reactRouterConfig as Hook)({});
    expect(config).toMatchObject({
      ssr: true,
      serverModuleFormat: "esm",
    });
  });

  test("buildEnd bundles the server build into the build directory", async () => {
    const options = await buildEnd({
      backend: "v8",
      intl: {
        locales: ["ja"],
      },
    });
    expect(options).toMatchObject({
      outDir: "/app/build",
      framework: "react-router",
      rendering: "streaming",
      backend: "v8",
      intl: {
        locales: ["ja"],
      },
    });
    const entry = options.entry as {
      source: string;
      resolveDir: string;
    };
    expect(entry.resolveDir.replaceAll("\\", "/")).toBe("/app/build/server");
    expect(entry.source).toContain('import * as build from "./index.js"');
    expect(entry.source).toContain("provider.set(fetchletContext");
    expect(options).not.toHaveProperty("assets");
  });

  test("assets cache the hashed files under /assets/ and ignore trailing slashes", async () => {
    const options = await buildEnd({
      assets: {
        entries: [],
      },
    });
    expect(options.assets).toStrictEqual({
      assets: {
        entries: [],
      },
      defaults: {
        cache: [
          {
            prefix: "/assets/",
            cacheControl: expect.stringContaining("immutable"),
          },
        ],
        routes: { trailingSlash: "ignore" },
      },
    });
  });
});

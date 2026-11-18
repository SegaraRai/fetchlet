import { join, resolve } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import fetchletBuild from "./vite.ts";

vi.mock(import("../../build/index.ts"), () => ({
  buildArtifact: vi.fn(),
}));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

beforeEach(() => {
  vi.mocked(buildArtifact).mockClear();
});

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const posix = (path: string) => path.replaceAll("\\", "/");

describe("fetchlet/hono/vite", () => {
  test("bundles the app with the Rust context in env", async () => {
    const plugin = fetchletBuild({ outDir: "dist", backend: "v8" });
    await (plugin.closeBundle as Hook).call({});
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    const serverDir = resolve(process.cwd(), "node_modules/.cache/fetchlet-hono");
    expect(options).toMatchObject({
      outDir: resolve(process.cwd(), "dist"),
      asyncContext: "serialized",
      framework: "hono",
      rendering: "streaming",
      backend: "v8",
      entry: {
        resolveDir: serverDir,
      },
    });
    const source = (options.entry as { source: string }).source;
    expect(source).toContain(`from ${JSON.stringify(posix(join(serverDir, "index.mjs")))}`);
    expect(source).toContain('[Symbol.for("fetchlet.hono.context")]: context');
    expect(source).not.toContain("export *");
    expect(options).not.toHaveProperty("assets");
  });

  test("functions reexports the module's named exports beside the handler", async () => {
    await (fetchletBuild({ functions: "src/functions.ts" }).closeBundle as Hook).call({});
    const source = (vi.mocked(buildArtifact).mock.lastCall![0].entry as { source: string }).source;
    expect(source).toContain(
      `export * from ${JSON.stringify(posix(resolve(process.cwd(), "src/functions.ts")))};`,
    );
  });

  test("assets take no framework caching rules", async () => {
    await (fetchletBuild({ assets: true }).closeBundle as Hook).call({});
    expect(vi.mocked(buildArtifact).mock.lastCall![0].assets).toStrictEqual({
      assets: true,
      defaults: {},
    });
  });
});

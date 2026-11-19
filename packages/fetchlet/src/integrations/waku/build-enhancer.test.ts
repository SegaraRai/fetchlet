import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import type { FetchletWakuOptions } from "./adapter.ts";
import buildEnhancer from "./build-enhancer.ts";

// Like buildArtifact, the mock creates the artifact directory.
vi.mock(import("../../build/index.ts"), () => ({
  buildArtifact: vi.fn(async ({ outDir }) => {
    mkdirSync(outDir, { recursive: true });
    return undefined as never;
  }),
}));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-waku-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function wakuOutput() {
  mkdirSync(join(directory, "dist", "server"), { recursive: true });
  mkdirSync(join(directory, "dist", "public"), { recursive: true });
  writeFileSync(join(directory, "dist", "server", "index.js"), "");
  writeFileSync(join(directory, "dist", "public", "index.html"), "<p>page</p>");
}

async function build(fetchlet?: FetchletWakuOptions) {
  const waku = vi.fn(async (_utils: unknown, _options: unknown) => {});
  const enhanced = await buildEnhancer(waku);
  await enhanced("utils" as never, { distDir: "dist", fetchlet } as never);
  return waku;
}

describe("fetchlet/waku build enhancer", () => {
  test("runs Waku's build first with its own arguments", async () => {
    wakuOutput();
    const waku = await build();
    expect(waku).toHaveBeenCalledWith("utils", {
      distDir: "dist",
      fetchlet: undefined,
    });
  });

  test("builds the RSC server and moves the public files to client/", async () => {
    wakuOutput();
    mkdirSync(join(directory, "build", "client"), { recursive: true });
    writeFileSync(join(directory, "build", "client", "stale.txt"), "");
    await build({ backend: "v8" });
    expect(vi.mocked(buildArtifact).mock.lastCall![0]).toMatchObject({
      outDir: join(directory, "build"),
      framework: "waku",
      asyncContext: "serialized",
      backend: "v8",
      entry: {
        resolveDir: join(directory, "dist", "server"),
        source: expect.stringContaining("INTERNAL_runFetch(env, request"),
      },
    });
    expect(readFileSync(join(directory, "build", "client", "index.html"), "utf8")).toBe(
      "<p>page</p>",
    );
    expect(existsSync(join(directory, "build", "client", "stale.txt"))).toBe(false);
    expect(existsSync(join(directory, "dist", "public"))).toBe(false);
    expect(vi.mocked(buildArtifact).mock.lastCall![0]).not.toHaveProperty("assets");
  });

  test("assets archive the moved client with /assets/ cached", async () => {
    wakuOutput();
    let clientMoved = false;
    vi.mocked(buildArtifact).mockImplementationOnce(async ({ outDir }) => {
      clientMoved = existsSync(join(outDir, "client"));
    });
    await build({ outDir: "out", assets: true });
    // The client is in place when buildArtifact archives it and writes the
    // manifest, once.
    expect(clientMoved).toBe(true);
    expect(vi.mocked(buildArtifact).mock.lastCall![0]).toMatchObject({
      outDir: join(directory, "out"),
      assets: {
        assets: true,
        defaults: {
          cache: [
            {
              prefix: "/assets/",
              cacheControl: expect.stringContaining("immutable"),
            },
          ],
        },
      },
    });
  });

  test("fails without Waku's server build", async () => {
    await expect(build()).rejects.toThrow(/found no server build/);
    expect(buildArtifact).not.toHaveBeenCalled();
  });
});

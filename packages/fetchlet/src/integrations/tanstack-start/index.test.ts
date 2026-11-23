import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import fetchletStart, { type FetchletStartOptions } from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-tanstack-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const startPlugin = (options?: FetchletStartOptions) => fetchletStart(options)[0]!;

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;
const chunk = (fileName: string, name: string, isEntry = true) => ({
  type: "chunk",
  fileName,
  name,
  isEntry,
});

describe("fetchlet/tanstack-start", () => {
  test("puts the client under outDir and bundles the SSR environment for Web engines", () => {
    const config = hook(startPlugin({ outDir: "out" }), "config").call({}) as {
      environments: Record<string, any>;
    };
    expect(config.environments.client.build.outDir).toBe(join("out", "client"));
    expect(config.environments.ssr.resolve.noExternal).toBe(true);
    expect(config.environments.ssr.resolve.conditions).toContain("fetchlet");
    expect(config.environments.ssr.resolve.conditions).not.toContain("edge-light");
    expect(config.environments.ssr.define["process.env.TSS_SHELL"]).toBe('"false"');
  });

  test("applies to the SSR environment, and to the client for watch builds", () => {
    const apply = hook(startPlugin(), "applyToEnvironment");
    expect(apply.call({}, { name: "ssr" })).toBe(true);
    expect(apply.call({}, { name: "client" })).toBe(true);
    expect(apply.call({}, { name: "provider" })).toBe(false);
  });

  test("resolves react-dom/server to its edge build", async () => {
    const resolve = vi.fn(async (source: string) => ({ id: source }));
    const resolveId = hook(startPlugin(), "resolveId");
    expect(await resolveId.call({ resolve }, "react-dom/server", "/app.js", {})).toStrictEqual({
      id: "react-dom/server.edge",
    });
    expect(resolve).toHaveBeenCalledWith("react-dom/server.edge", "/app.js", {
      skipSelf: true,
    });
    expect(resolveId.call({ resolve }, "react", "/app.js", {})).toBeUndefined();
  });

  test("writeBundle bundles the server entry chunk", async () => {
    writeFileSync(join(directory, "server-abc.js"), "");
    const plugin = startPlugin({
      outDir: join(directory, "build"),
      assets: true,
    });
    hook(plugin, "configResolved").call(
      {},
      {
        root: directory,
        base: "/",
        build: {
          assetsDir: "assets",
        },
      },
    );
    await hook(plugin, "writeBundle").call(
      {},
      {
        dir: directory,
      },
      {
        a: chunk("other.js", "other"),
        b: chunk("server-abc.js", "server"),
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options).toMatchObject({
      outDir: join(directory, "build"),
      framework: "tanstack-start",
      rendering: "streaming",
      asyncContext: "serialized",
      entry: {
        resolveDir: directory,
      },
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
    expect((options.entry as { source: string }).source).toContain("server-abc.js");
  });

  test("writeBundle fails without a server entry", async () => {
    const plugin = startPlugin();
    await expect(
      hook(plugin, "writeBundle").call(
        {},
        {
          dir: directory,
        },
        {},
      ),
    ).rejects.toThrow(/found no server entry/);
    expect(buildArtifact).not.toHaveBeenCalled();
  });
});

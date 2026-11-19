import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import {
  findServerEntry,
  serverEnvironmentPlugin,
  writeServerArtifact,
  type ServerEnvironmentIntegration,
} from "./server-environment.ts";

vi.mock(import("../../build/index.ts"), () => ({ buildArtifact: vi.fn() }));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-vite-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;

const integration: ServerEnvironmentIntegration = {
  name: "fetchlet/test",
  framework: "test",
  rendering: "streaming",
  entrySource: (serverModule) => `export { handle } from ${JSON.stringify(serverModule)};`,
};

const chunk = (fileName: string, name: string, isEntry = true) => ({
  type: "chunk",
  fileName,
  name,
  isEntry,
});

describe("serverEnvironmentPlugin", () => {
  test("sends the client build to <outDir>/client and bundles every server dependency", () => {
    const plugin = serverEnvironmentPlugin(
      {
        ...integration,
        serverEnvironment: {
          resolve: {
            conditions: ["worker"],
          },
          build: {
            minify: false,
          },
        },
      },
      {
        outDir: "out",
      },
    );
    const config = hook(plugin, "config").call({}) as { environments: Record<string, any> };
    expect(config.environments.client.build.outDir).toBe(join("out", "client"));
    expect(config.environments.ssr.resolve).toStrictEqual({
      noExternal: true,
      conditions: ["worker"],
    });
    expect(config.environments.ssr.build).toStrictEqual({
      outDir: "node_modules/.cache/fetchlet-test",
      // fetchlet/build adds the runtime; a second copy would install it twice.
      rolldownOptions: { external: [/^fetchlet\/runtime(\/|$)/] },
      minify: false,
    });
    expect(hook(plugin, "applyToEnvironment").call({}, { name: "ssr" })).toBe(true);
    expect(hook(plugin, "applyToEnvironment").call({}, { name: "client" })).toBe(false);
  });

  test("wraps the chosen server entry and caches the hashed assets for a year", async () => {
    writeFileSync(join(directory, "server.js"), "");
    const plugin = serverEnvironmentPlugin(
      {
        ...integration,
        asyncContext: "serialized",
        isServerEntry: (entry) => entry.name === "server",
      },
      {
        outDir: "build",
        backend: "quickjs",
        assets: true,
      },
    );
    hook(plugin, "configResolved").call(
      {},
      {
        root: directory,
        base: "/app",
        build: {
          assetsDir: "static/",
        },
      },
    );
    await hook(plugin, "writeBundle").call(
      {},
      {
        dir: directory,
      },
      {
        other: chunk("other.js", "other"),
        server: chunk("server.js", "server"),
        lazy: chunk("lazy.js", "lazy", false),
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options).toMatchObject({
      outDir: join(directory, "build"),
      framework: "test",
      rendering: "streaming",
      asyncContext: "serialized",
      backend: "quickjs",
      entry: {
        resolveDir: directory,
      },
      assets: {
        assets: true,
        defaults: {
          cache: [{ prefix: "/app/static/", cacheControl: expect.stringContaining("immutable") }],
        },
      },
    });
    expect((options.entry as { source: string }).source).toContain(
      JSON.stringify(join(directory, "server.js")),
    );
  });

  test("leaves the archive out and async context unset unless asked", async () => {
    writeFileSync(join(directory, "entry.js"), "");
    const plugin = serverEnvironmentPlugin(integration, {});
    await hook(plugin, "writeBundle").call(
      {},
      {
        dir: directory,
      },
      {
        entry: chunk("entry.js", "x"),
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options.assets).toBeUndefined();
    expect(options.asyncContext).toBeUndefined();
  });

  test("fails when the bundle has no server entry", async () => {
    const plugin = serverEnvironmentPlugin(integration, {});
    await expect(
      hook(plugin, "writeBundle").call(
        {},
        {
          dir: directory,
        },
        {
          entry: chunk("gone.js", "x"),
        },
      ),
    ).rejects.toThrow(/fetchlet\/test found no server entry/);
  });

  test("takes the hashed asset directory from the client environment", async () => {
    writeFileSync(join(directory, "entry.js"), "");
    const plugin = serverEnvironmentPlugin(integration, {
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
        environments: {
          client: {
            build: {
              assetsDir: "_build/assets",
            },
          },
        },
      },
    );
    await hook(plugin, "writeBundle").call(
      {},
      {
        dir: directory,
      },
      {
        entry: chunk("entry.js", "x"),
      },
    );
    expect(vi.mocked(buildArtifact).mock.lastCall![0].assets).toMatchObject({
      defaults: {
        cache: [{ prefix: "/_build/assets/" }],
      },
    });
  });
});

describe("findServerEntry", () => {
  test("names the integration and what it looked for when the entry is missing", () => {
    writeFileSync(join(directory, "main.js"), "");
    const bundle = {
      main: chunk("main.js", "main"),
      other: chunk("other.js", "other"),
    } as never;
    expect(findServerEntry(integration, bundle, directory, (c) => c.name === "main")).toBe(
      join(directory, "main.js"),
    );
    expect(() =>
      findServerEntry(integration, bundle, directory, (c) => c.name === "app", '"app" entry'),
    ).toThrow(`fetchlet/test found no "app" entry in ${directory}`);
  });
});

describe("writeServerArtifact", () => {
  test("adds the hashed asset prefix after the framework's cache rules", async () => {
    await writeServerArtifact(
      {
        ...integration,
        assetDefaults: {
          cache: [{ prefix: "/build/", cacheControl: "public" }],
        },
      },
      {
        assets: true,
      },
      {
        root: directory,
        serverModule: join(directory, "server", "index.js"),
        hashedAssets: "/a/",
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options.entry).toMatchObject({
      resolveDir: join(directory, "server"),
    });
    expect(options.outDir).toBe(join(directory, "build"));
    expect(options.assets).toMatchObject({
      defaults: {
        cache: [
          {
            prefix: "/build/",
            cacheControl: "public",
          },
          { prefix: "/a/" },
        ],
      },
    });
  });

  test("passes the framework defaults unchanged without cache rules", async () => {
    await writeServerArtifact(
      integration,
      {
        assets: true,
      },
      {
        root: directory,
        serverModule: join(directory, "index.js"),
      },
    );
    expect(vi.mocked(buildArtifact).mock.lastCall![0].assets).toStrictEqual({
      assets: true,
      defaults: {},
    });
  });
});

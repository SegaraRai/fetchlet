import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("serverEnvironmentPlugin under vite build --watch", () => {
  const watched = (environment: string, watchMode = true) => ({
    environment: { name: environment },
    meta: { watchMode },
    addWatchFile: vi.fn(),
    info: vi.fn(),
  });

  function watchedPlugin(extra: Partial<ServerEnvironmentIntegration> = {}) {
    const plugin = serverEnvironmentPlugin(
      { ...integration, embedsClientBuild: true, ...extra },
      { outDir: "build" },
    );
    hook(plugin, "configResolved").call(
      {},
      {
        root: directory,
        base: "/",
        build: { assetsDir: "assets" },
        environments: {
          client: { build: { outDir: join("build", "client"), assetsDir: "assets" } },
        },
      },
    );
    return plugin;
  }

  const stampFile = () => join(directory, "build", "client", ".vite", "fetchlet-client-build");

  test("also applies to the client environment", () => {
    const plugin = watchedPlugin();
    expect(hook(plugin, "applyToEnvironment").call({}, { name: "client" })).toBe(true);
  });

  test("the first server build waits for the client build to be written", async () => {
    const plugin = watchedPlugin();
    let started = false;
    const server = Promise.resolve(hook(plugin, "buildStart").call(watched("ssr"))).then(() => {
      started = true;
    });
    await hook(plugin, "buildStart").call(watched("client"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(false);
    await hook(plugin, "writeBundle").call(watched("client"), { dir: directory }, {});
    await server;
    expect(started).toBe(true);
    expect(existsSync(stampFile())).toBe(true);
    // A server build after it starts at once.
    await hook(plugin, "buildStart").call(watched("ssr"));
  });

  test("a failed client build releases the waiting server build", async () => {
    const plugin = watchedPlugin();
    const server = hook(plugin, "buildStart").call(watched("ssr"));
    hook(plugin, "buildEnd").call(watched("client"), new Error("syntax"));
    await server;
  });

  test("every server build watches the client build's stamp", async () => {
    const plugin = watchedPlugin();
    await hook(plugin, "buildStart").call(watched("client"));
    await hook(plugin, "writeBundle").call(watched("client"), { dir: directory }, {});
    const context = watched("ssr");
    await hook(plugin, "buildStart").call(context);
    expect(context.addWatchFile).toHaveBeenCalledWith(stampFile());
  });

  test("a server build that a client build started after is not written", async () => {
    writeFileSync(join(directory, "entry.js"), "");
    const plugin = watchedPlugin();
    await hook(plugin, "buildStart").call(watched("client"));
    await hook(plugin, "writeBundle").call(watched("client"), { dir: directory }, {});
    const server = watched("ssr");
    await hook(plugin, "buildStart").call(server);
    // An edit starts the next client build while the server bundles.
    await hook(plugin, "buildStart").call(watched("client"));
    await hook(plugin, "writeBundle").call(
      server,
      { dir: directory },
      {
        entry: chunk("entry.js", "x"),
      },
    );
    expect(buildArtifact).not.toHaveBeenCalled();
    expect(server.info).toHaveBeenCalled();
    // The server build the client build causes is written.
    await hook(plugin, "writeBundle").call(watched("client"), { dir: directory }, {});
    const next = watched("ssr");
    await hook(plugin, "buildStart").call(next);
    await hook(plugin, "writeBundle").call(
      next,
      { dir: directory },
      {
        entry: chunk("entry.js", "x"),
      },
    );
    expect(buildArtifact).toHaveBeenCalledOnce();
  });

  test("plugins created per environment follow the same client builds", async () => {
    // Solid's plugin loads the configuration once per environment.
    const client = watchedPlugin();
    const server = watchedPlugin();
    const waiting = hook(server, "buildStart").call(watched("ssr"));
    await hook(client, "buildStart").call(watched("client"));
    await hook(client, "writeBundle").call(watched("client"), { dir: directory }, {});
    await waiting;
  });

  test("each server build starts with the last client build written", async () => {
    const serverBuildStarting = vi.fn();
    const plugin = watchedPlugin({ serverBuildStarting });
    const bundle = { entry: chunk("entry.js", "x") };
    await hook(plugin, "buildStart").call(watched("client"));
    await hook(plugin, "writeBundle").call(watched("client"), { dir: directory }, bundle);
    await hook(plugin, "buildStart").call(watched("ssr"));
    await hook(plugin, "buildStart").call(watched("ssr"));
    expect(serverBuildStarting).toHaveBeenCalledTimes(2);
    expect(serverBuildStarting).toHaveBeenLastCalledWith({ bundle, dir: directory });
  });

  test("a single build neither waits, watches nor writes the stamp", async () => {
    const plugin = watchedPlugin();
    const context = watched("ssr", false);
    await hook(plugin, "buildStart").call(context);
    await hook(plugin, "writeBundle").call(watched("client", false), { dir: directory }, {});
    expect(existsSync(stampFile())).toBe(false);
    expect(context.addWatchFile).not.toHaveBeenCalled();
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

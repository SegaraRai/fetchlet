import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import fetchlet from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({
  buildArtifact: vi.fn(),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-vite-app-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;

/** Runs the plugin's `buildApp` and returns the environments it built, in order. */
async function builtEnvironments(config: { builder: { buildApp: Hook } }): Promise<string[]> {
  const built: string[] = [];
  await config.builder.buildApp.call(undefined, {
    environments: {
      client: {
        name: "client",
      },
      ssr: {
        name: "ssr",
      },
    },
    build: async (environment: { name: string }) => {
      built.push(environment.name);
    },
  });
  return built;
}

describe("fetchlet/vite", () => {
  test("builds the client entries, then the server module", async () => {
    const [app, artifact] = fetchlet({
      server: "app/server.ts",
      client: "app/client.ts",
    });
    const config = hook(app!, "config").call(
      {},
      {
        root: directory,
      },
    ) as any;
    expect(config.environments.client.build).toStrictEqual({
      manifest: true,
      rolldownOptions: { input: ["app/client.ts"] },
    });
    expect(config.environments.ssr.build.rolldownOptions.input).toStrictEqual({
      server: "app/server.ts",
    });
    expect(await builtEnvironments(config)).toStrictEqual(["client", "ssr"]);
    expect(artifact!.name).toBe("fetchlet/vite");
  });

  test("skips the client build without entries or index.html", async () => {
    const [app] = fetchlet();
    const config = hook(app!, "config").call(
      {},
      {
        root: directory,
      },
    ) as any;
    expect(config.environments.ssr.build.rolldownOptions.input).toStrictEqual({
      server: "src/server.ts",
    });
    expect(await builtEnvironments(config)).toStrictEqual(["ssr"]);

    writeFileSync(join(directory, "index.html"), "<!doctype html>");
    const withHtml = hook(app!, "config").call(
      {},
      {
        root: directory,
      },
    ) as any;
    expect(withHtml.environments.client.build.rolldownOptions).toBeUndefined();
    expect(await builtEnvironments(withHtml)).toStrictEqual(["client", "ssr"]);
  });

  test("gives the server the built URLs of each client entry", async () => {
    const client = join(directory, "dist", "client");
    mkdirSync(join(client, ".vite"), { recursive: true });
    writeFileSync(
      join(client, ".vite", "manifest.json"),
      JSON.stringify({
        "src/client.ts": {
          file: "assets/client-1.js",
          isEntry: true,
          css: ["assets/client-1.css"],
          imports: ["_shared.js"],
        },
        "_shared.js": {
          file: "assets/shared-2.js",
          css: ["assets/shared-2.css"],
        },
        "src/lazy.ts": {
          file: "assets/lazy-3.js",
          isDynamicEntry: true,
        },
      }),
    );
    const [app] = fetchlet({
      client: "src/client.ts",
    });
    hook(app!, "configResolved").call(
      {},
      {
        root: directory,
        base: "/base",
        environments: {
          client: {
            build: {
              outDir: "dist/client",
              manifest: true,
            },
          },
        },
      },
    );
    const watched: string[] = [];
    const id = hook(app!, "resolveId").call({}, "virtual:fetchlet/client-assets") as string;
    const source = hook(app!, "load").call(
      {
        environment: {
          mode: "build",
        },
        addWatchFile: (file: string) => watched.push(file),
      },
      id,
    ) as string;
    // A client rebuild under --watch rewrites the manifest and so the server.
    expect(watched).toStrictEqual([join(client, ".vite", "manifest.json")]);
    expect(JSON.parse(source.replace(/^export default |;$/g, ""))).toStrictEqual({
      "src/client.ts": {
        script: "/base/assets/client-1.js",
        styles: ["/base/assets/client-1.css", "/base/assets/shared-2.css"],
      },
    });
  });

  test("serves the client sources behind Vite's HMR client during development", () => {
    const [app] = fetchlet({
      client: "./src/client.ts",
    });
    hook(app!, "configResolved").call(
      {},
      {
        root: directory,
        base: "/",
        environments: {},
      },
    );
    const source = hook(app!, "load").call(
      {
        environment: {
          mode: "dev",
        },
      },
      "\0virtual:fetchlet/client-assets",
    ) as string;
    expect(source).toContain(
      '"src/client.ts":{"script":"/@fetchlet/client?entry=src%2Fclient.ts","styles":[]}',
    );
  });
});

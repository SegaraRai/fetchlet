import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { frameworkAssets, type AssetsOption } from "../../build/asset-option.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletStartOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses TanStack Start's: hashed files under `assets/`
   * are cached for a year; settings adjust those defaults and add entries, and
   * a function returns every entry. See docs/asset-archive.md.
   */
  assets?: AssetsOption;
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

/** The request context the fetchlet entry passes to TanStack Start. */
export interface FetchletRequestContext<Env = Readonly<Record<string, unknown>>> {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Env;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

/**
 * A Vite plugin for TanStack Start that builds the server environment into a
 * fetchlet artifact: server.js and fetchlet.json next to `client/`.
 */
export default function fetchletStart({
  outDir = "build",
  backend = "portable",
  intl = {},
  assets = false,
}: FetchletStartOptions = {}): Plugin {
  let root = process.cwd();
  let serverDirectory: string | undefined;
  return {
    name: "fetchlet/tanstack-start",
    enforce: "pre",
    config() {
      return {
        environments: {
          client: { build: { outDir: join(outDir, "client") } },
          ssr: {
            // Web-standard builds of dependencies, such as react-dom/server.edge,
            // resolved and bundled here. fetchlet/build bundles the output again.
            resolve: {
              conditions: ["worker", "edge-light", "module", "import", "production", "default"],
              externalConditions: [
                "worker",
                "edge-light",
                "module",
                "import",
                "production",
                "default",
              ],
              noExternal: true,
            },
            // Start reads these at module evaluation; the engine has no process.
            define: {
              "process.env.TSS_PRERENDERING": JSON.stringify("false"),
              "process.env.TSS_SHELL": JSON.stringify("false"),
            },
            build: { outDir: "node_modules/.cache/fetchlet-tanstack-start" },
          },
        },
      };
    },
    configResolved(config) {
      root = config.root;
    },
    applyToEnvironment(environment) {
      return environment.name === "ssr";
    },
    // The worker build of react-dom/server schedules work with MessageChannel,
    // which the engines do not provide; the edge build uses setTimeout.
    resolveId(source, importer, options) {
      if (source === "react-dom/server") {
        return this.resolve("react-dom/server.edge", importer, {
          ...options,
          skipSelf: true,
        });
      }
    },
    configEnvironment(name, config) {
      if (name === "ssr") {
        serverDirectory = config.build?.outDir;
      }
    },
    async writeBundle(options, bundle) {
      const directory = resolve(root, options.dir ?? serverDirectory ?? "");
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry && chunk.name === "server",
      );
      const serverModule = join(directory, entryChunk?.fileName ?? "server.js");
      if (!existsSync(serverModule)) {
        throw new Error("fetchlet/tanstack-start found no server entry in " + directory);
      }
      const entrySource = `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import server from ${JSON.stringify(modulePath(serverModule))};

        const env = getBindings();

        export const handle = createFetchHandler((request, context = {}) =>
          server.fetch(request, {
            context: { clientAddress: context.clientAddress, env, waitUntil },
          }),
        );
        `;
      await buildArtifact({
        entry: {
          source: entrySource,
          resolveDir: directory,
        },
        outDir: resolve(root, outDir),
        framework: "tanstack-start",
        rendering: "streaming",
        asyncContext: "serialized",
        backend,
        intl,
        ...(assets
          ? {
              assets: frameworkAssets(assets, {
                cache: [{ prefix: "/assets/", cacheControl: IMMUTABLE }],
              }),
            }
          : {}),
      });
    },
  };
}

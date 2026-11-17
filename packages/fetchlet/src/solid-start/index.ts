import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";
import { frameworkAssets, IMMUTABLE, type AssetArchiveSettings } from "../build/asset-archive.ts";

export type { FetchletBindings, FetchletRequestContext } from "./context.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletSolidStartOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses SolidStart's: hashed files under `_build/assets/`
   * are cached for a year; an object adds
   * `respond`, which runs after them, and `routes`. See docs/asset-archive.md.
   */
  assets?: boolean | AssetArchiveSettings;
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

/**
 * A Vite plugin for SolidStart that builds the server environment into a
 * fetchlet artifact: server.js and fetchlet.json next to `client/`.
 */
export default function fetchletSolidStart({
  outDir = "build",
  backend = "portable",
  intl = {},
  assets = false,
}: FetchletSolidStartOptions = {}): Plugin {
  let root = process.cwd();
  let serverDirectory: string | undefined;
  return {
    name: "fetchlet/solid-start",
    config() {
      return {
        environments: {
          client: {
            build: {
              outDir: join(outDir, "client"),
            },
          },
          ssr: {
            resolve: {
              noExternal: true,
            },
            build: {
              outDir: "node_modules/.cache/fetchlet-solid-start",
            },
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
    configEnvironment(name, config) {
      if (name === "ssr") {
        serverDirectory = config.build?.outDir;
        // Bundle every dependency for a Web-standard server: "solid" compiles
        // Solid libraries from source for SSR, "worker" selects the server
        // build of solid-js, and h3 keeps its generic build.
        return {
          resolve: {
            conditions: ["solid", "worker", "generic", "module", "import", "production", "default"],
          },
        };
      }
    },
    async writeBundle(options, bundle) {
      const directory = resolve(root, options.dir ?? serverDirectory ?? "");
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry,
      );
      const serverModule = entryChunk && join(directory, entryChunk.fileName);
      if (!serverModule || !existsSync(serverModule)) {
        throw new Error("fetchlet/solid-start found no server entry in " + directory);
      }
      // h3 reads the client address, waitUntil and the runtime from the
      // request; srvx adapters for other platforms set the same fields.
      const entrySource = `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import app from ${JSON.stringify(modulePath(serverModule))};

        const env = getBindings();

        export const handle = createFetchHandler((request, context = {}) => {
          Object.defineProperties(request, {
            ip: { value: context.clientAddress, configurable: true },
            waitUntil: { value: waitUntil, configurable: true },
            runtime: {
              value: {
                name: "fetchlet",
                fetchlet: { clientAddress: context.clientAddress, env, waitUntil },
              },
              configurable: true,
            },
          });
          return app.fetch(request);
        });
        `;
      await buildArtifact({
        entry: {
          source: entrySource,
          resolveDir: directory,
        },
        outDir: resolve(root, outDir),
        framework: "solid-start",
        rendering: "streaming",
        asyncContext: "serialized",
        backend,
        intl,
        ...(assets
          ? {
              assets: frameworkAssets(assets, {
                cache: [{ prefix: "/_build/assets/", cacheControl: IMMUTABLE }],
              }),
            }
          : {}),
      });
    },
  };
}

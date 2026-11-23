import { parse, resolve } from "node:path";

import type { Plugin } from "vite";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { runtimeConditions } from "../../build/conditions.ts";
import {
  findServerEntry,
  importPath,
  writeServerArtifact,
  type ArtifactIntegration,
  type ViteArtifactOptions,
} from "../vite/server-environment.ts";

/**
 * `assets: true` caches Qwik's hashed files under `build/` and `assets/` for
 * a year. `outDir` also holds the client build, in `client/`.
 */
export interface FetchletQwikCityOptions extends ViteArtifactOptions {
  /** The server entry that default-exports `createQwikCity(...)`. Defaults to "src/entry.fetchlet.tsx". */
  entry?: string;
}

const serverDirectory = "node_modules/.cache/fetchlet-qwik-city";

const integration: ArtifactIntegration = {
  name: "fetchlet/qwik-city",
  framework: "qwik-city",
  rendering: "streaming",
  asyncContext: "serialized",
  entrySource: (serverModule) => `
    import { createFetchHandler } from "fetchlet/runtime/adapter";
    import handler from ${importPath(serverModule)};

    export const handle = createFetchHandler(handler);
  `,
  assetDefaults: {
    cache: [
      { prefix: "/assets/", cacheControl: IMMUTABLE },
      { prefix: "/build/", cacheControl: IMMUTABLE },
    ],
  },
};

/**
 * A Vite plugin for Qwik City. In the SSR build (`vp build --ssr`) it builds
 * `entry` with the route plan and writes a fetchlet artifact next to the
 * client build.
 */
export function fetchletAdapter({
  entry = "src/entry.fetchlet.tsx",
  ...fetchletOptions
}: FetchletQwikCityOptions = {}): Plugin {
  let root = process.cwd();
  let ssr = false;
  return {
    name: "fetchlet/qwik-city",
    apply: "build",
    enforce: "post",
    config(_config, env) {
      if (!env.isSsrBuild) {
        return;
      }
      return {
        // fetchlet's builds of dependencies, bundled into one module.
        resolve: {
          conditions: runtimeConditions(),
        },
        ssr: {
          target: "webworker",
          noExternal: true,
        },
        publicDir: false,
        build: {
          ssr: true,
          outDir: serverDirectory,
          rollupOptions: {
            input: [entry, "@qwik-city-plan"],
            // fetchlet/build adds the runtime once, before the framework;
            // a copy bundled here would install the Web API profile twice.
            external: [/^fetchlet\/runtime(\/|$)/],
          },
        },
      };
    },
    // Qwik groups client modules into chunks named after their module paths,
    // which Rolldown rejects as chunk names. The files are named by hash.
    outputOptions(output) {
      const manualChunks = output.manualChunks;
      if (ssr || typeof manualChunks !== "function") {
        return;
      }
      return {
        ...output,
        manualChunks(id, meta) {
          const name = manualChunks(id, meta);
          return typeof name === "string" ? name.replace(/[^\w-]+/g, "_") : name;
        },
      };
    },
    configResolved(config) {
      root = config.root;
      ssr = Boolean(config.build.ssr);
    },
    async writeBundle(outputOptions, bundle) {
      if (!ssr) {
        return;
      }
      const name = parse(entry).name;
      const directory = outputOptions.dir ?? resolve(root, serverDirectory);
      const serverModule = findServerEntry(
        integration,
        bundle,
        directory,
        (chunk) => chunk.name === name,
        `"${name}" entry`,
      );
      await writeServerArtifact(integration, fetchletOptions, {
        root,
        serverModule,
        resolveDir: directory,
      });
    },
  };
}

import { existsSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";

import type { Plugin } from "vite";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletQwikCityOptions {
  /** The server entry that default-exports `createQwikCity(...)`. Defaults to "src/entry.fetchlet.tsx". */
  entry?: string;
  /** Where server.js and fetchlet.json are written, next to the client build in `client/`. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

/**
 * A Vite plugin for Qwik City. In the SSR build (`vp build --ssr`) it builds
 * `entry` with the route plan and writes a fetchlet artifact next to the
 * client build.
 */
export function fetchletAdapter({
  entry = "src/entry.fetchlet.tsx",
  outDir = "build",
  backend = "portable",
  intl = {},
}: FetchletQwikCityOptions = {}): Plugin {
  let root = process.cwd();
  let ssr = false;
  return {
    name: "fetchlet/qwik-city",
    apply: "build",
    enforce: "post",
    config(config, env) {
      if (!env.isSsrBuild) {
        return;
      }
      return {
        // Web-standard builds of dependencies, bundled into one module.
        resolve: {
          conditions: ["edge-light", "webworker", "worker", "browser", "module", "main"],
        },
        ssr: { target: "webworker", noExternal: true },
        publicDir: false,
        build: {
          ssr: true,
          outDir: "node_modules/.cache/fetchlet-qwik-city",
          rollupOptions: { input: [entry, "@qwik-city-plan"] },
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
    async writeBundle(options, bundle) {
      if (!ssr) {
        return;
      }
      const name = parse(entry).name;
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry && chunk.name === name,
      );
      const directory = options.dir ?? resolve(root, "node_modules/.cache/fetchlet-qwik-city");
      const serverModule = entryChunk && join(directory, entryChunk.fileName);
      if (!serverModule || !existsSync(serverModule)) {
        throw new Error(`fetchlet/qwik-city found no "${name}" entry in ${directory}`);
      }
      const fetchletEntry = join(directory, "fetchlet.mjs");
      writeFileSync(
        fetchletEntry,
        `
        import { createFetchHandler } from "fetchlet/runtime/adapter";
        import handler from ${JSON.stringify(modulePath(serverModule))};

        export const handle = createFetchHandler(handler);
        `,
      );
      await buildArtifact({
        entry: fetchletEntry,
        outDir: resolve(root, outDir),
        framework: "qwik-city",
        rendering: "streaming",
        asyncContext: "serialized",
        backend,
        intl,
      });
    },
  };
}

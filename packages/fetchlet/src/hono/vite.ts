import { join, resolve } from "node:path";

import buildPlugin from "@hono/vite-build";
import type { Plugin } from "vite";

import { frameworkAssets, type AssetsOption } from "../build/asset-option.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletBuildOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses no caching rules, since a Hono app's public files
   * may not be hashed;
   * settings adjust those defaults and add entries, and a function returns every entry. See docs/asset-archive.md.
   */
  assets?: AssetsOption;
  /** The app modules, as in @hono/vite-build. */
  entry?: string | string[];
  /** Where server.js and fetchlet.json are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
  /** Modules kept out of the server bundle. */
  external?: string[];
  /**
   * A module whose named exports Rust calls with `App::call` / `AppHandle::call`
   * beside the Fetch handler. The export name `handle` is reserved.
   */
  functions?: string;
}

/** Build a Hono app into a fetchlet artifact. */
export default function fetchletBuild({
  entry = ["./src/index.ts", "./src/index.tsx", "./app/server.ts"],
  outDir = "build",
  backend = "portable",
  intl = {},
  external = [],
  functions,
  assets = false,
}: FetchletBuildOptions = {}): Plugin {
  let root = process.cwd();
  const base = buildPlugin({
    entry,
    output: "index.mjs",
    outputDir: "./node_modules/.cache/fetchlet-hono",
    external,
    minify: false,
    emptyOutDir: true,
    // Rust serves the public files.
    staticPaths: [],
    entryContentDefaultExportHook: (appName: string) => `export default ${appName}`,
  });
  return {
    ...base,
    name: "fetchlet/hono/vite",
    configResolved(config) {
      root = config.root;
      const hook = base.configResolved;
      return typeof hook === "function" ? hook.call(this, config) : undefined;
    },
    async closeBundle() {
      const serverDir = resolve(root, "node_modules/.cache/fetchlet-hono");
      // Named exports of `functions` stay callable from Rust beside the Fetch handler.
      const functionExports = functions
        ? `export * from ${JSON.stringify(modulePath(resolve(root, functions)))};`
        : "";
      const entrySource = `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import app from ${JSON.stringify(modulePath(join(serverDir, "index.mjs")))};

        const bindings = getBindings();
        const executionContext = {
          waitUntil,
          passThroughOnException() {},
          props: {},
        };

        ${functionExports}

        export const handle = createFetchHandler((request, context = {}) =>
          app.fetch(
            request,
            { ...bindings, [Symbol.for("fetchlet.hono.context")]: context },
            executionContext,
          ),
        );
        `;
      await buildArtifact({
        entry: {
          source: entrySource,
          resolveDir: serverDir,
        },
        outDir: resolve(root, outDir),
        asyncContext: "serialized",
        framework: "hono",
        rendering: "streaming",
        backend,
        intl,
        ...(assets ? { assets: frameworkAssets(assets, {}) } : {}),
      });
    },
  };
}

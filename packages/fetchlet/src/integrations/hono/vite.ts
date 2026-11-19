import { join, resolve } from "node:path";

import buildPlugin from "@hono/vite-build";
import type { Plugin } from "vite";

import {
  importPath,
  writeServerArtifact,
  type ViteArtifactOptions,
} from "../vite/server-environment.ts";

/**
 * `assets: true` adds no caching rules, since a Hono app's public files may
 * not be hashed.
 */
export interface FetchletBuildOptions extends ViteArtifactOptions {
  /** The app modules, as in @hono/vite-build. */
  entry?: string | string[];
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
  external = [],
  functions,
  ...options
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
        ? `export * from ${importPath(resolve(root, functions))};`
        : "";
      await writeServerArtifact(
        {
          name: "fetchlet/hono/vite",
          framework: "hono",
          rendering: "streaming",
          asyncContext: "serialized",
          entrySource: (serverModule) => `
            import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
            import app from ${importPath(serverModule)};

            ${functionExports}

            const bindings = getBindings();
            const executionContext = {
              waitUntil,
              passThroughOnException() {},
              props: {},
            };

            export const handle = createFetchHandler((request, context = {}) =>
              app.fetch(
                request,
                {
                  ...bindings,
                  [Symbol.for("fetchlet.hono.context")]: context,
                },
                executionContext,
              ),
            );
          `,
        },
        options,
        {
          root,
          serverModule: join(serverDir, "index.mjs"),
        },
      );
    },
  };
}

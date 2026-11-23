import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { frameworkAssets, type AssetsOption } from "../../build/asset-option.ts";
import { runtimeConditions } from "../../build/conditions.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";
import { vinextNodeCompat, vinextNodeDefines } from "./node-compat.ts";

export type { FetchletBindings, FetchletRequestContext, ServiceBinding } from "./context.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletVinextOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses vinext's: hashed files under `_next/static/` are
   * cached for a year; settings adjust those defaults and add entries, and
   * a function returns every entry. See docs/asset-archive.md.
   */
  assets?: AssetsOption;
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
  /**
   * APIs the application needs beyond the Web API profile, as in
   * fetchlet/build: Intl APIs such as `Intl.DateTimeFormat`, and globals over
   * host Web APIs such as `crypto.subtle`. Recorded in fetchlet.json, where
   * the Rust host checks them before the server runs.
   */
  requirements?: string[];
}

// React's server packages, such as react-server-dom-webpack/client, have
// server-side builds only under "workerd" or "edge-light" among the Web
// runtime keys; their "worker" builds expect a browser.
const extraConditions = ["workerd"];
const serverConditions = [...extraConditions, ...runtimeConditions()];

/**
 * A Vite plugin for the vinext App Router. The client build goes to the
 * artifact's `client/` directory, and after vinext has built every
 * environment, the RSC server becomes the artifact's server.js.
 */
export default function fetchletVinext({
  outDir = "build",
  backend = "portable",
  intl = {},
  requirements = [],
  assets = false,
}: FetchletVinextOptions = {}): Plugin {
  let root = process.cwd();
  return {
    name: "fetchlet/vinext",
    apply: "build",
    configEnvironment(name) {
      // The client build is the artifact's client/ directory.
      if (name === "client") {
        return {
          build: {
            outDir: join(outDir, "client"),
          },
        };
      }
      if (name === "rsc" || name === "ssr") {
        return {
          resolve: {
            conditions: serverConditions,
            noExternal: true,
          },
        };
      }
    },
    configResolved(config) {
      root = config.root;
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        const serverDirectory = resolve(root, builder.environments.rsc.config.build.outDir);
        const serverModule = join(serverDirectory, "index.js");
        if (!existsSync(serverModule)) {
          throw new Error("fetchlet/vinext found no App Router server build at " + serverModule);
        }
        const entrySource = `
          import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
          import { runWithRequestContext } from "fetchlet/vinext/context";
          import handler from ${JSON.stringify(modulePath(serverModule))};

          const env = getBindings();

          export const handle = createFetchHandler((request, context = {}) => {
            const requestContext = {
              clientAddress: context.clientAddress,
              env,
              waitUntil,
            };
            return runWithRequestContext(requestContext, () =>
              handler(request, {
                waitUntil,
                passThroughOnException() {},
              }),
            );
          });
          `;
        const output = resolve(root, outDir);
        await buildArtifact({
          entry: {
            source: entrySource,
            resolveDir: serverDirectory,
          },
          outDir: output,
          framework: "vinext",
          rendering: "streaming",
          asyncContext: "serialized",
          // vinext keeps React external in its SSR build.
          conditions: extraConditions,
          plugins: [vinextNodeCompat()],
          define: vinextNodeDefines,
          backend,
          intl,
          requirements,
          ...(assets
            ? {
                assets: frameworkAssets(assets, {
                  cache: [{ prefix: "/_next/static/", cacheControl: IMMUTABLE }],
                }),
              }
            : {}),
        });
      },
    },
  };
}

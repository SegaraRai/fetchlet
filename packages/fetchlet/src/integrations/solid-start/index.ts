import type { Plugin } from "vite";

import { devServerPlugin } from "../vite/dev-server.ts";
import {
  importPath,
  serverEnvironmentPlugin,
  type ViteArtifactOptions,
} from "../vite/server-environment.ts";

export type { FetchletBindings, FetchletRequestContext } from "./context.ts";

/**
 * `assets: true` caches SolidStart's hashed files under `_build/assets/`
 * for a year.
 */
export interface FetchletSolidStartOptions extends ViteArtifactOptions {}

/**
 * A Vite plugin for SolidStart that builds the server environment into a
 * fetchlet artifact: server.js and fetchlet.json next to `client/`.
 */
export default function fetchletSolidStart(options: FetchletSolidStartOptions = {}): Plugin[] {
  const build = serverEnvironmentPlugin(
    {
      name: "fetchlet/solid-start",
      framework: "solid-start",
      rendering: "streaming",
      asyncContext: "serialized",
      // SolidStart embeds the client's Vite manifest and fails without it.
      embedsClientBuild: true,
      // solid-start:capture-client-bundle stores every environment's bundle
      // in these globals, so a server build replaces the client's with its
      // own; each server build under --watch reads the client's again.
      serverBuildStarting(client) {
        Object.assign(globalThis, {
          START_CLIENT_BUNDLE: client.bundle,
          START_CLIENT_OUT_DIR: client.dir,
        });
      },
      serverEnvironment: {
        resolve: {
          // Bundle every dependency for a Web-standard server: "solid" compiles
          // Solid libraries from source for SSR, "worker" selects the server
          // build of solid-js, and h3 keeps its generic build.
          conditions: ["solid", "worker", "generic", "module", "import", "production", "default"],
        },
      },
      // h3 reads the client address, waitUntil and the runtime from the
      // request; srvx adapters for other platforms set the same fields.
      entrySource: (serverModule) => `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import app from ${importPath(serverModule)};

        const env = getBindings();

        export const handle = createFetchHandler((request, context = {}) => {
          Object.defineProperties(request, {
            ip: {
              value: context.clientAddress,
              configurable: true,
            },
            waitUntil: {
              value: waitUntil,
              configurable: true,
            },
            runtime: {
              value: {
                name: "fetchlet",
                fetchlet: {
                  clientAddress: context.clientAddress,
                  env,
                  waitUntil,
                },
              },
              configurable: true,
            },
          });
          return app.fetch(request);
        });
      `,
    },
    options,
  );
  return [
    build,
    devServerPlugin({
      name: "fetchlet/solid-start:dev-server",
      entry: "solid-start:server-entry",
      framework: "solid-start",
      rendering: "streaming",
      asyncContext: "serialized",
      dispatch: `(module, request, env, ctx) => {
        Object.defineProperties(request, {
          ip: {
            value: ctx.clientAddress,
            configurable: true,
          },
          waitUntil: {
            value: ctx.waitUntil,
            configurable: true,
          },
          runtime: {
            value: {
              name: "fetchlet",
              fetchlet: {
                clientAddress: ctx.clientAddress,
                env,
                waitUntil: ctx.waitUntil,
              },
            },
            configurable: true,
          },
        });
        return module.default.fetch(request);
      }`,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.intl ? { intl: options.intl } : {}),
    }),
  ];
}

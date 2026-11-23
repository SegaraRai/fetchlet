import type { Plugin } from "vite";

import { runtimeConditions } from "../../build/conditions.ts";
import {
  importPath,
  serverEnvironmentPlugin,
  type ViteArtifactOptions,
} from "../vite/server-environment.ts";

export type { FetchletBindings, FetchletRequestContext } from "./context.ts";

export interface FetchletSolidOptions extends ViteArtifactOptions {}

/**
 * A Vite plugin for Solid 2's server mode (`@solidjs/vite-plugin` with
 * `start` and `ssr: true`) that builds the server bundle into a fetchlet
 * artifact: server.js and fetchlet.json next to `client/`. Requests reach
 * Solid's `handleRequest` with the fetchlet request context on the request
 * event, where `getRequestContext()` from fetchlet/solid/context reads it.
 */
export default function fetchletSolid(options: FetchletSolidOptions = {}): Plugin {
  return serverEnvironmentPlugin(
    {
      name: "fetchlet/solid",
      framework: "solid",
      rendering: "streaming",
      // Solid's server runtime keeps the request event in AsyncLocalStorage.
      asyncContext: "serialized",
      // virtual:solid-manifest embeds the client build it recorded.
      embedsClientBuild: true,
      serverEnvironment: {
        resolve: {
          // "solid" compiles Solid libraries from source for SSR.
          conditions: ["solid", ...runtimeConditions()],
        },
      },
      entrySource: (serverModule) => `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import { handleRequest } from ${importPath(serverModule)};

        const env = getBindings();

        export const handle = createFetchHandler((request, context = {}) =>
          handleRequest(request, {
            event: {
              fetchlet: {
                clientAddress: context.clientAddress,
                env,
                waitUntil,
              },
            },
          }),
        );
      `,
    },
    options,
  );
}

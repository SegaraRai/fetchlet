import type { FetchletBindings } from "fetchlet/bindings";
import type { Plugin } from "vite";

import { devServerPlugin } from "../vite/dev-server.ts";
import {
  importPath,
  serverEnvironmentPlugin,
  type ViteArtifactOptions,
} from "../vite/server-environment.ts";

/** `assets: true` caches TanStack Start's hashed files under `assets/` for a year. */
export interface FetchletStartOptions extends ViteArtifactOptions {}

/** The request context the fetchlet entry passes to TanStack Start. */
export interface FetchletRequestContext<Env = Readonly<FetchletBindings>> {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Env;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

// Web-standard builds of dependencies, such as react-dom/server.edge,
// resolved and bundled here. fetchlet/build bundles the output again.
const conditions = ["worker", "edge-light", "module", "import", "production", "default"];

/**
 * A Vite plugin for TanStack Start that builds the server environment into a
 * fetchlet artifact: server.js and fetchlet.json next to `client/`.
 */
export default function fetchletStart(options: FetchletStartOptions = {}): Plugin[] {
  const build: Plugin = {
    ...serverEnvironmentPlugin(
      {
        name: "fetchlet/tanstack-start",
        framework: "tanstack-start",
        rendering: "streaming",
        asyncContext: "serialized",
        isServerEntry: (chunk) => chunk.name === "server",
        // Start's manifest module embeds the client build it recorded.
        embedsClientBuild: true,
        serverEnvironment: {
          resolve: {
            conditions,
            externalConditions: conditions,
          },
          // Start reads these at module evaluation; the engine has no process.
          define: {
            "process.env.TSS_PRERENDERING": JSON.stringify("false"),
            "process.env.TSS_SHELL": JSON.stringify("false"),
          },
        },
        entrySource: (serverModule) => `
          import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
          import server from ${importPath(serverModule)};

          const env = getBindings();

          export const handle = createFetchHandler((request, context = {}) =>
            server.fetch(request, {
              context: {
                clientAddress: context.clientAddress,
                env,
                waitUntil,
              },
            }),
          );
        `,
      },
      options,
    ),
    enforce: "pre",
    // The worker build of react-dom/server schedules work with MessageChannel,
    // which the engines do not provide; the edge build uses setTimeout.
    resolveId(source, importer, resolveOptions) {
      if (source === "react-dom/server") {
        return this.resolve("react-dom/server.edge", importer, {
          ...resolveOptions,
          skipSelf: true,
        });
      }
    },
  };
  return [
    build,
    // `vite dev` serves the Rust host, which runs Start's server entry on
    // its engine with the same request context as the artifact.
    devServerPlugin({
      name: "fetchlet/tanstack-start:dev-server",
      entry: "virtual:tanstack-start-server-entry",
      framework: "tanstack-start",
      rendering: "streaming",
      asyncContext: "serialized",
      // CommonJS, and resolved by the hook above, so it is named up front.
      include: ["react-dom/server.edge"],
      dispatch: `(module, request, env, ctx) =>
        module.default.fetch(request, {
          context: {
            clientAddress: ctx.clientAddress,
            env,
            waitUntil: ctx.waitUntil,
          },
        })`,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.intl ? { intl: options.intl } : {}),
    }),
  ];
}

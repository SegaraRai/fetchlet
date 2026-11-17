import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";
import { vinextNodeCompat, vinextNodeDefines } from "./node-compat.ts";

export type { FetchletBindings, FetchletRequestContext, ServiceBinding } from "./context.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletVinextOptions {
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

// Web-standard builds, such as react-dom/server.edge, bundled with the server.
const serverConditions = ["workerd", "edge-light", "worker"];

/**
 * A Vite plugin for the vinext App Router. After vinext has built every
 * environment, it builds the RSC server into a fetchlet artifact and copies
 * the client build to `client/` beside it.
 */
export default function fetchletVinext({
  outDir = "build",
  backend = "portable",
  intl = {},
}: FetchletVinextOptions = {}): Plugin {
  let root = process.cwd();
  return {
    name: "fetchlet/vinext",
    apply: "build",
    configEnvironment(name) {
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
        const clientDirectory = resolve(root, builder.environments.client.config.build.outDir);
        const serverModule = join(serverDirectory, "index.js");
        if (!existsSync(serverModule)) {
          throw new Error("fetchlet/vinext found no App Router server build at " + serverModule);
        }
        const entry = join(serverDirectory, "fetchlet.mjs");
        writeFileSync(
          entry,
          `
          import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
          import { runWithRequestContext } from "fetchlet/vinext/context";
          import handler from ${JSON.stringify(modulePath(serverModule))};

          const env = getBindings();

          export const handle = createFetchHandler((request, context = {}) => {
            const requestContext = { clientAddress: context.clientAddress, env, waitUntil };
            return runWithRequestContext(requestContext, () =>
              handler(request, { waitUntil, passThroughOnException() {} }),
            );
          });
          `,
        );
        const output = resolve(root, outDir);
        await buildArtifact({
          entry,
          outDir: output,
          framework: "vinext",
          rendering: "streaming",
          asyncContext: "serialized",
          // vinext keeps React external in its SSR build.
          conditions: serverConditions,
          plugins: [vinextNodeCompat()],
          define: vinextNodeDefines,
          backend,
          intl,
        });
        const client = join(output, "client");
        rmSync(client, { recursive: true, force: true });
        cpSync(clientDirectory, client, { recursive: true });
      },
    },
  };
}

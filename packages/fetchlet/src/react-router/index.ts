import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Preset } from "@react-router/dev/config";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletPresetOptions {
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

interface ArtifactOptions {
  reactRouterConfig: { buildDirectory: string; serverBuildFile: string };
  backend: BuildBackend;
  intl: IntlOptions;
}

/**
 * A React Router preset that bundles the server build into a fetchlet
 * artifact: server.js and fetchlet.json next to build/client.
 */
export function fetchletPreset({
  backend = "portable",
  intl = {},
}: FetchletPresetOptions = {}): Preset {
  return {
    name: "fetchlet/react-router",
    reactRouterConfig: () => ({
      ssr: true,
      serverModuleFormat: "esm",
      buildEnd: ({ reactRouterConfig }) =>
        writeArtifact({
          reactRouterConfig,
          backend,
          intl,
        }),
    }),
    reactRouterConfigResolved({ reactRouterConfig }) {
      if (reactRouterConfig.serverBundles) {
        throw new Error("fetchlet/react-router builds one server bundle");
      }
      if (!reactRouterConfig.ssr) {
        throw new Error("fetchlet/react-router requires ssr: true");
      }
    },
  };
}

async function writeArtifact({ reactRouterConfig, backend, intl }: ArtifactOptions): Promise<void> {
  const { buildDirectory, serverBuildFile } = reactRouterConfig;
  const serverDirectory = join(buildDirectory, "server");
  const entry = join(serverDirectory, "fetchlet.mjs");
  writeFileSync(
    entry,
    `
    import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
    import { createRequestHandler, RouterContextProvider } from "react-router";
    import { fetchletContext } from "fetchlet/react-router/context";
    import * as build from ${JSON.stringify("./" + modulePath(serverBuildFile))};

    const handler = createRequestHandler(build, "production");
    const env = getBindings();

    export const handle = createFetchHandler((request, context = {}) => {
      const provider = new RouterContextProvider();
      provider.set(fetchletContext, {
        clientAddress: context.clientAddress,
        env,
        waitUntil,
      });
      return handler(request, provider);
    });
    `,
  );
  await buildArtifact({
    entry,
    outDir: buildDirectory,
    framework: "react-router",
    rendering: "streaming",
    backend,
    intl,
  });
}

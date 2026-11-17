import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArtifact } from "../build/index.js";

const modulePath = (file) => file.replaceAll("\\", "/");

/**
 * A React Router preset that bundles the server build into a fetchlet
 * artifact: server.js and fetchlet.json next to build/client.
 *
 * @param {{ backend?: string, intl?: object }} [options]
 * @returns {import("@react-router/dev/config").Preset}
 */
export function fetchletPreset({ backend = "portable", intl = {} } = {}) {
  return {
    name: "fetchlet/react-router",
    reactRouterConfig: () => ({
      ssr: true,
      serverModuleFormat: "esm",
      buildEnd: ({ buildManifest, reactRouterConfig }) =>
        writeArtifact({ buildManifest, reactRouterConfig, backend, intl }),
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

async function writeArtifact({ reactRouterConfig, backend, intl }) {
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
      const value = { clientAddress: context.clientAddress, env, waitUntil };
      if (!build.future?.v8_middleware) {
        return handler(request, value);
      }
      const provider = new RouterContextProvider();
      provider.set(fetchletContext, value);
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

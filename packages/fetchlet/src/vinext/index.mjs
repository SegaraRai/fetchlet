import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifact } from "../build/index.mjs";
import { vinextNodeCompat } from "./node-compat.mjs";

const modulePath = (file) => file.replaceAll("\\", "/");
const contextModule = modulePath(fileURLToPath(new URL("./context.mjs", import.meta.url)));

// Web-standard builds, such as react-dom/server.edge, bundled with the server.
const serverConditions = ["workerd", "edge-light", "worker"];

/**
 * A Vite plugin for the vinext App Router. After vinext has built every
 * environment, it builds the RSC server into a fetchlet artifact and copies
 * the client build to `client/` beside it.
 *
 * @param {import("./index").FetchletVinextOptions} [options]
 * @returns {import("vite").Plugin}
 */
export default function fetchletVinext({ outDir = "build", backend = "portable", intl = {} } = {}) {
  let root = process.cwd();
  return {
    name: "fetchlet/vinext",
    apply: "build",
    configEnvironment(name) {
      if (name === "rsc" || name === "ssr") {
        return { resolve: { conditions: serverConditions, noExternal: true } };
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
          import { runWithRequestContext } from ${JSON.stringify(contextModule)};
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

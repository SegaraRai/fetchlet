import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildArtifact } from "../build/index.js";

const modulePath = (file) => file.replaceAll("\\", "/");

/**
 * A Vite plugin for SolidStart that builds the server environment into a
 * fetchlet artifact: server.js and fetchlet.json next to `client/`.
 *
 * @param {import("./index").FetchletSolidStartOptions} [options]
 * @returns {import("vite").Plugin}
 */
export default function fetchletSolidStart({
  outDir = "build",
  backend = "portable",
  intl = {},
} = {}) {
  let root = process.cwd();
  let serverDirectory;
  return {
    name: "fetchlet/solid-start",
    config() {
      return {
        environments: {
          client: { build: { outDir: join(outDir, "client") } },
          ssr: {
            resolve: { noExternal: true },
            build: { outDir: "node_modules/.cache/fetchlet-solid-start" },
          },
        },
      };
    },
    configResolved(config) {
      root = config.root;
    },
    applyToEnvironment(environment) {
      return environment.name === "ssr";
    },
    configEnvironment(name, config) {
      if (name === "ssr") {
        serverDirectory = config.build?.outDir;
        // Bundle every dependency for a Web-standard server: "solid" compiles
        // Solid libraries from source for SSR, "worker" selects the server
        // build of solid-js, and h3 keeps its generic build.
        return {
          resolve: {
            conditions: ["solid", "worker", "generic", "module", "import", "production", "default"],
          },
        };
      }
    },
    async writeBundle(options, bundle) {
      const directory = resolve(root, options.dir ?? serverDirectory);
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry,
      );
      const serverModule = entryChunk && join(directory, entryChunk.fileName);
      if (!serverModule || !existsSync(serverModule)) {
        throw new Error("fetchlet/solid-start found no server entry in " + directory);
      }
      const entry = join(directory, "fetchlet.mjs");
      // h3 reads the client address, waitUntil and the runtime from the
      // request; srvx adapters for other platforms set the same fields.
      writeFileSync(
        entry,
        `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import app from ${JSON.stringify(modulePath(serverModule))};

        const env = getBindings();

        export const handle = createFetchHandler((request, context = {}) => {
          Object.defineProperties(request, {
            ip: { value: context.clientAddress, configurable: true },
            waitUntil: { value: waitUntil, configurable: true },
            runtime: {
              value: {
                name: "fetchlet",
                fetchlet: { clientAddress: context.clientAddress, env, waitUntil },
              },
              configurable: true,
            },
          });
          return app.fetch(request);
        });
        `,
      );
      await buildArtifact({
        entry,
        outDir: resolve(root, outDir),
        framework: "solid-start",
        rendering: "streaming",
        asyncContext: "serialized",
        backend,
        intl,
      });
    },
  };
}

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildArtifact } from "@fetchlet/build";

const modulePath = (file) => file.replaceAll("\\", "/");

/**
 * A Vite plugin for TanStack Start that builds the server environment into a
 * fetchlet artifact: server.js and fetchlet.json next to `client/`.
 *
 * @param {import("./index").FetchletStartOptions} [options]
 * @returns {import("vite").Plugin}
 */
export default function fetchletStart({ outDir = "build", backend = "portable", intl = {} } = {}) {
  let root = process.cwd();
  let serverDirectory;
  return {
    name: "@fetchlet/tanstack-start",
    enforce: "pre",
    config() {
      return {
        environments: {
          client: { build: { outDir: join(outDir, "client") } },
          ssr: {
            // Web-standard builds of dependencies, such as react-dom/server.edge,
            // resolved and bundled here. @fetchlet/build bundles the output again.
            resolve: {
              conditions: ["worker", "edge-light", "module", "import", "production", "default"],
              externalConditions: [
                "worker",
                "edge-light",
                "module",
                "import",
                "production",
                "default",
              ],
              noExternal: true,
            },
            // Start reads these at module evaluation; the engine has no process.
            define: {
              "process.env.TSS_PRERENDERING": JSON.stringify("false"),
              "process.env.TSS_SHELL": JSON.stringify("false"),
            },
            build: { outDir: "node_modules/.cache/fetchlet-tanstack-start" },
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
    // The worker build of react-dom/server schedules work with MessageChannel,
    // which the engines do not provide; the edge build uses setTimeout.
    resolveId(source, importer, options) {
      if (source === "react-dom/server") {
        return this.resolve("react-dom/server.edge", importer, { ...options, skipSelf: true });
      }
    },
    configEnvironment(name, config) {
      if (name === "ssr") {
        serverDirectory = config.build?.outDir;
      }
    },
    async writeBundle(options, bundle) {
      const directory = resolve(root, options.dir ?? serverDirectory);
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry && chunk.name === "server",
      );
      const serverModule = join(directory, entryChunk?.fileName ?? "server.js");
      if (!existsSync(serverModule)) {
        throw new Error("@fetchlet/tanstack-start found no server entry in " + directory);
      }
      const entry = join(directory, "fetchlet.mjs");
      writeFileSync(
        entry,
        `
        import { createFetchHandler, getBindings, waitUntil } from "@fetchlet/runtime/adapter";
        import server from ${JSON.stringify(modulePath(serverModule))};

        const env = getBindings();

        export const handle = createFetchHandler((request, context = {}) =>
          server.fetch(request, {
            context: { clientAddress: context.clientAddress, env, waitUntil },
          }),
        );
        `,
      );
      await buildArtifact({
        entry,
        outDir: resolve(root, outDir),
        framework: "tanstack-start",
        rendering: "streaming",
        asyncContext: "serialized",
        backend,
        intl,
      });
    },
  };
}

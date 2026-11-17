import { existsSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { buildArtifact } from "../build/index.mjs";

const modulePath = (file) => file.replaceAll("\\", "/");

/**
 * A Vite plugin for Qwik City. In the SSR build (`vp build --ssr`) it builds
 * `entry` with the route plan and writes a fetchlet artifact next to the
 * client build.
 *
 * @param {import("./vite").FetchletQwikCityOptions} [options]
 * @returns {import("vite").Plugin}
 */
export function fetchletAdapter({
  entry = "src/entry.fetchlet.tsx",
  outDir = "build",
  backend = "portable",
  intl = {},
} = {}) {
  let root = process.cwd();
  let ssr = false;
  return {
    name: "fetchlet/qwik-city",
    apply: "build",
    enforce: "post",
    config(config, env) {
      if (!env.isSsrBuild) {
        return;
      }
      return {
        // Web-standard builds of dependencies, bundled into one module.
        resolve: {
          conditions: ["edge-light", "webworker", "worker", "browser", "module", "main"],
        },
        ssr: { target: "webworker", noExternal: true },
        publicDir: false,
        build: {
          ssr: true,
          outDir: "node_modules/.cache/fetchlet-qwik-city",
          rollupOptions: { input: [entry, "@qwik-city-plan"] },
        },
      };
    },
    // Qwik groups client modules into chunks named after their module paths,
    // which Rolldown rejects as chunk names. The files are named by hash.
    outputOptions(output) {
      const manualChunks = output.manualChunks;
      if (ssr || typeof manualChunks !== "function") {
        return;
      }
      return {
        ...output,
        manualChunks(id, meta) {
          const name = manualChunks(id, meta);
          return typeof name === "string" ? name.replace(/[^\w-]+/g, "_") : name;
        },
      };
    },
    configResolved(config) {
      root = config.root;
      ssr = Boolean(config.build.ssr);
    },
    async writeBundle(options, bundle) {
      if (!ssr) {
        return;
      }
      const name = parse(entry).name;
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry && chunk.name === name,
      );
      const serverModule = entryChunk && join(options.dir, entryChunk.fileName);
      if (!serverModule || !existsSync(serverModule)) {
        throw new Error(`fetchlet/qwik-city found no "${name}" entry in ${options.dir}`);
      }
      const fetchletEntry = join(options.dir, "fetchlet.mjs");
      writeFileSync(
        fetchletEntry,
        `
        import { createFetchHandler } from "fetchlet/runtime/adapter";
        import handler from ${JSON.stringify(modulePath(serverModule))};

        export const handle = createFetchHandler(handler);
        `,
      );
      await buildArtifact({
        entry: fetchletEntry,
        outDir: resolve(root, outDir),
        framework: "qwik-city",
        rendering: "streaming",
        asyncContext: "serialized",
        backend,
        intl,
      });
    },
  };
}

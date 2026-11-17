import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import buildPlugin from "@hono/vite-build";
import { buildArtifact } from "@fetchlet/build";

const modulePath = (file) => file.replaceAll("\\", "/");

export default function fetchletBuild({
  entry = ["./src/index.ts", "./src/index.tsx", "./app/server.ts"],
  outDir = "build",
  backend = "portable",
  intl = {},
  external = [],
  functions,
} = {}) {
  let root = process.cwd();
  const base = buildPlugin({
    entry,
    output: "index.mjs",
    outputDir: "./node_modules/.cache/fetchlet-hono",
    external,
    minify: false,
    emptyOutDir: true,
    // Rust serves the public files.
    staticPaths: [],
    entryContentDefaultExportHook: (appName) => `export default ${appName}`,
  });
  return {
    ...base,
    name: "@fetchlet/hono/vite",
    configResolved(config) {
      root = config.root;
      return base.configResolved?.(config);
    },
    async closeBundle() {
      const serverDir = resolve(root, "node_modules/.cache/fetchlet-hono");
      const fetchEntry = join(serverDir, "fetchlet.mjs");
      // Named exports of `functions` stay callable from Rust beside the Fetch handler.
      const functionExports = functions
        ? `export * from ${JSON.stringify(modulePath(resolve(root, functions)))};`
        : "";
      writeFileSync(
        fetchEntry,
        `
        import { createFetchHandler, getBindings, waitUntil } from "@fetchlet/runtime/adapter";
        import app from ${JSON.stringify(modulePath(join(serverDir, "index.mjs")))};

        const bindings = getBindings();
        const executionContext = {
          waitUntil,
          passThroughOnException() {},
          props: {},
        };

        ${functionExports}

        export const handle = createFetchHandler((request, context = {}) =>
          app.fetch(
            request,
            { ...bindings, [Symbol.for("fetchlet.hono.context")]: context },
            executionContext,
          ),
        );
        `,
      );
      await buildArtifact({
        entry: fetchEntry,
        outDir: resolve(root, outDir),
        asyncContext: "serialized",
        framework: "hono",
        rendering: "buffered",
        backend,
        intl,
      });
    },
  };
}

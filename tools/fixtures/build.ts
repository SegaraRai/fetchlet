// Bundles the compatibility fixtures into artifacts/: `vp run build:fixtures`.
//
// functions-hono.js and sveltekit.js serve the runtime and host matrices and
// the embed example.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";
import { build, createBuilder, type Plugin } from "vite-plus";

const artifacts = resolve(root, "artifacts");
mkdirSync(artifacts, { recursive: true });

const noAsyncHooks: Plugin = {
  name: "fetchlet-no-async-hooks",
  resolveId(id) {
    if (id === "node:async_hooks") {
      return "\0fetchlet-no-async-hooks";
    }
  },
  load(id) {
    if (id === "\0fetchlet-no-async-hooks") {
      return 'throw new Error("AsyncLocalStorage is unavailable in the portable profile"); export const AsyncLocalStorage=undefined;';
    }
  },
};

async function bundle(name: string, entry: string, target = "es2022"): Promise<void> {
  await build({
    configFile: false,
    root,
    resolve: {
      mainFields: ["module", "main"],
      conditions: ["module", "production"],
      // readable-stream, under fetchlet/node/stream, requires the npm process
      // package, whose main module is Node's global; fetchlet/build serves
      // fetchlet's process for it, and so does this bundle.
      alias: { "process/": "fetchlet/node/process" },
    },
    plugins: [noAsyncHooks],
    define: { "process.env.NODE_ENV": '"production"' },
    esbuild: { jsx: "automatic", jsxImportSource: "hono/jsx" },
    build: {
      target,
      outDir: artifacts,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: resolve(root, entry),
        formats: ["iife"],
        name: "fetchletExports",
        fileName: () => name + ".js",
      },
      rolldownOptions: { output: { inlineDynamicImports: true } },
    },
    ssr: { noExternal: true },
  });
}

await bundle("functions-hono", "fixtures/entry.ts");

// The SvelteKit app builds first; its entry then imports the generated server.
const kitRoot = resolve(root, "fixtures/sveltekit");
process.chdir(kitRoot);
const kitBuilder = await createBuilder({
  root: kitRoot,
  configFile: resolve(kitRoot, "vite.config.ts"),
});
await kitBuilder.buildApp();
process.chdir(root);
await bundle("sveltekit", "fixtures/sveltekit/entry.ts");

writeFileSync(
  resolve(artifacts, "build-info.json"),
  JSON.stringify(
    {
      profile: "portable Web APIs; synchronous SSR rendering; Rust host fetch bindings",
    },
    null,
    2,
  ),
);

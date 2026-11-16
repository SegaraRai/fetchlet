import { build, createBuilder } from "vite-plus";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.cwd();
mkdirSync("artifacts", { recursive: true });
const noAsyncHooks = {
  name: "fetchlet-no-async-hooks",
  resolveId(id) {
    if (id === "node:async_hooks") return "\0fetchlet-no-async-hooks";
  },
  load(id) {
    if (id === "\0fetchlet-no-async-hooks")
      return 'throw new Error("AsyncLocalStorage is unavailable in the portable profile"); export const AsyncLocalStorage=undefined;';
  },
};
async function bundle(name, entry, target = "es2022") {
  await build({
    configFile: false,
    resolve: { mainFields: ["module", "main"], conditions: ["module", "production"] },
    plugins: [noAsyncHooks],
    define: { "process.env.NODE_ENV": '"production"' },
    esbuild: { jsx: "automatic", jsxImportSource: "hono/jsx" },
    build: {
      target,
      outDir: resolve("artifacts"),
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: resolve(entry),
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
const kitRoot = resolve("fixtures/sveltekit");
process.chdir(kitRoot);
const kitBuilder = await createBuilder({ root: kitRoot, configFile: resolve("vite.config.ts") });
await kitBuilder.buildApp();
process.chdir(root);
await bundle("sveltekit", "fixtures/sveltekit/entry.ts");
await bundle("aot-hono", "fixtures/aot/hono.ts", "es2019");
await bundle("aot-sveltekit", "fixtures/aot/sveltekit.ts", "es2019");
writeFileSync(
  "artifacts/build-info.json",
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      profile: "portable Web APIs; synchronous SSR rendering; Rust host fetch bindings",
    },
    null,
    2,
  ),
);

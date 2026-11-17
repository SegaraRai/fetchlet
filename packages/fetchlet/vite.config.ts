import { cpSync, rmSync } from "node:fs";

import { defineConfig } from "vite-plus";

// The JavaScript modules and their hand-written declarations are published as
// they are; only the TypeScript entries are compiled, next to them in dist/.
const typescriptEntries = [
  "src/runtime/index.ts",
  "src/runtime/adapter.ts",
  "src/runtime/handler.ts",
  "src/astro/server.ts",
  "src/hono/conninfo.ts",
  "src/react-router/context.ts",
];

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: false,
      },
    },
  },
  pack: {
    entry: typescriptEntries,
    unbundle: true,
    root: "src",
    outDir: "dist",
    dts: true,
    // The runtime runs in the guest engine, not in Node.
    platform: "neutral",
    // The language level of the final artifact bundle.
    target: "es2022",
    outExtensions: () => ({
      js: ".js",
      dts: ".d.ts",
    }),
    hooks: {
      "build:prepare": () => {
        rmSync("dist", { recursive: true, force: true });
      },
    },
    onSuccess() {
      cpSync("src", "dist", {
        recursive: true,
        filter: (path) => !path.endsWith(".ts") || path.endsWith(".d.ts"),
      });
    },
  },
});

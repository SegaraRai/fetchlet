import { cpSync, readFileSync, rmSync } from "node:fs";

import { defineConfig } from "vite-plus";

const manifest = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

// Every module an export names; unbundled, the modules they import compile
// next to them in dist/.
const entries = Object.values<string>(manifest.exports).filter((file) => !file.endsWith(".d.ts"));

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "fetchlet",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: false,
      },
    },
  },
  pack: {
    entry: entries,
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
    // Declaration-only modules, such as fetchlet/nitro/types, are published as written.
    onSuccess() {
      cpSync("src", "dist", {
        recursive: true,
        filter: (path) => !path.endsWith(".ts") || path.endsWith(".d.ts"),
      });
    },
  },
});

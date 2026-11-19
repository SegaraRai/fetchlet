import { resolve } from "node:path";

import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
import { defineConfig } from "vite-plus";

const cargo = "node ../../tools/workspace/cargo.ts";

// Demo notes are copied here so that editing them leaves sample/ unchanged.
// Cargo runs from the repository root, so the path is absolute, with forward
// slashes, which the task shell leaves alone.
const demo = resolve(import.meta.dirname, "../../.cache/sveltekit-axum-tauri/notes").replaceAll(
  "\\",
  "/",
);

const dev = `fetchlet dev --watch web --watch vite.config.ts --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-sveltekit-axum-tauri --features dev`;

export default defineConfig({
  plugins: [
    sveltekit({
      files: {
        src: "web",
        assets: "web/static",
      },
      compilerOptions: {
        experimental: {
          // `await` in components, rendered on the server through fetchlet.
          async: true,
        },
      },
      experimental: {
        remoteFunctions: true,
      },
      adapter: fetchletAdapter({
        backend: process.env.FETCHLET_BACKEND as "quickjs" | "boa" | "v8" | undefined,
        rendering: "async",
        // Packed into build/assets.flpk, which build.rs embeds in mdw.
        assets: true,
      }),
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      "generate:api": {
        command: `${cargo} run --locked -p example-sveltekit-axum-tauri --no-default-features -- openapi --output examples/sveltekit-axum-tauri/openapi.json && openapi-ts && vp fmt openapi.json web/lib/api`,
        cache: false,
      },
      "check:types": {
        command: "svelte-check --tsconfig ./tsconfig.json",
        dependsOn: ["build"],
        cache: false,
      },
      "prepare:demo": {
        command: `node scripts/prepare-demo.ts sample ${demo}`,
        cache: false,
      },
      serve: {
        command: `${cargo} run --locked -p example-sveltekit-axum-tauri -- serve ${demo} --open`,
        dependsOn: ["build", "prepare:demo"],
        cache: false,
      },
      desktop: {
        command: `${cargo} run --locked -p example-sveltekit-axum-tauri -- desktop ${demo}`,
        dependsOn: ["build", "prepare:demo"],
        cache: false,
      },
      // Rebuild on source changes while mdw reloads each build.
      "dev:serve": {
        command: `${dev} -- serve ${demo} --open`,
        dependsOn: ["prepare:demo"],
        cache: false,
      },
      "dev:desktop": {
        command: `${dev} -- desktop ${demo}`,
        dependsOn: ["prepare:demo"],
        cache: false,
      },
    },
  },
});

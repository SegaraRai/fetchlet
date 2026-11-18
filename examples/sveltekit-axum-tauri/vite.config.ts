import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
import { defineConfig } from "vite-plus";

const cargo = "node ../../tools/workspace/cargo.ts";

// Demo notes are copied here so that editing them leaves sample/ unchanged.
const demo = "../../.cache/sveltekit-axum-tauri/notes";

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
        command: `${cargo} run --locked -p example-sveltekit-axum-tauri --no-default-features -- openapi --output openapi.json && openapi-ts && vp fmt web/lib/api`,
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
    },
  },
});

import fetchletAdapter from "@fetchlet/sveltekit-adapter";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    sveltekit({
      files: {
        src: "web",
        assets: "web/static",
      },
      compilerOptions: {
        experimental: {
          async: false,
        },
      },
      adapter: fetchletAdapter({
        backend: process.env.FETCHLET_BACKEND as "quickjs" | "boa" | "v8" | undefined,
      }),
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      "check:types": {
        command: "svelte-check --tsconfig ./tsconfig.json",
        dependsOn: ["build"],
        cache: false,
      },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-sveltekit-axum",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

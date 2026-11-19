import svelte from "@astrojs/svelte";
import { defineConfig } from "astro/config";
import fetchletAdapter from "fetchlet/astro";
import type { BuildBackend } from "fetchlet/build";

export default defineConfig({
  srcDir: "./web",
  publicDir: "./web/static",
  cacheDir: "./.astro",
  output: "server",
  build: {
    inlineStylesheets: "never",
  },
  adapter: fetchletAdapter({
    backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as BuildBackend,
    assets: true,
    // `astro dev` serves the Rust host of the `dev:vite` task.
    devServer: true,
  }),
  integrations: [
    svelte({
      compilerOptions: {
        experimental: {
          async: false,
        },
      },
    }),
  ],
  image: {
    service: {
      entrypoint: "astro/assets/services/noop",
    },
  },
});

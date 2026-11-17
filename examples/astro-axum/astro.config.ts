import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
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

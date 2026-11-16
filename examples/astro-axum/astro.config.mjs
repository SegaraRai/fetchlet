import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import fetchletAdapter from "@fetchlet/astro-adapter";

export default defineConfig({
  srcDir: "./web",
  publicDir: "./web/static",
  cacheDir: "./.astro",
  output: "server",
  build: { inlineStylesheets: "never" },
  adapter: fetchletAdapter({ backend: "quickjs" }),
  integrations: [svelte({ compilerOptions: { experimental: { async: false } } })],
  image: { service: { entrypoint: "astro/assets/services/noop" } },
});

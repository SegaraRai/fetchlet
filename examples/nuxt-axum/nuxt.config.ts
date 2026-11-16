/// <reference types="@fetchlet/nitro-preset/types" />

export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  srcDir: "web",
  serverDir: "web/server",
  dir: {
    public: "web/public",
  },
  devtools: {
    enabled: false,
  },
  telemetry: false,
  // NUXT_MESSAGE from the Rust host bindings overrides this value.
  runtimeConfig: {
    message: "",
  },
  nitro: {
    preset: "@fetchlet/nitro-preset",
    fetchlet: {
      backend: "quickjs",
    },
  },
});

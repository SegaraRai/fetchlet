import { defineConfig } from "cf/config";

export default defineConfig(({ isPreview }) => ({
  worker: {
    name: "fetchlet-website",
    compatibilityDate: "2026-11-27",
    workersDev: false,
    previewUrls: true,
    domains: [
      ...(isPreview ? [] : ["fetchlet.roundtrip.dev"]),
      {
        // A Preview name becomes the first subdomain, such as main.fetchlet-preview.roundtrip.dev.
        hostname: "fetchlet-preview.roundtrip.dev",
        production: false,
        previews: true,
      },
    ],
    assets: {
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
    },
  },
}));

import { defineConfig, lintPresets } from "stillwind/config";

export default defineConfig({
  projects: [
    {
      css: "src/styles.css",
      files: ["src/**/*.{astro,ts}"],
      lint: {
        extends: [lintPresets.strict, lintPresets.stylistic],
        rules: {
          "no-arbitrary-breakpoints": "deny",
          "no-arbitrary-colors": "deny",
        },
      },
    },
  ],
});

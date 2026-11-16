import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: { command: "astro build", cache: false },
      serve: {
        command: "pwsh -NoProfile -File ../../tools/cargo.ps1 run --locked -p example-astro-axum",
        dependsOn: ["build"],
        cache: false,
      },
      "check:types": {
        command: "astro check",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

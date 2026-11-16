import { defineConfig } from "vite-plus";

// Waku builds with its own Vite configuration in waku.config.ts; this file
// defines the tasks.
export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "waku build",
        cache: false,
      },
      serve: {
        command: "pwsh -NoProfile -File ../../tools/cargo.ps1 run --locked -p example-waku-axum",
        dependsOn: ["build"],
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        cache: false,
      },
    },
  },
});

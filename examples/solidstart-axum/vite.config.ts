import fetchletSolidStart from "@fetchlet/solid-start";
import { solidStart } from "@solidjs/start/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [solidStart(), fetchletSolidStart({ backend: "quickjs" })],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      serve: {
        command:
          "pwsh -NoProfile -File ../../tools/cargo.ps1 run --locked -p example-solidstart-axum",
        dependsOn: ["build"],
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

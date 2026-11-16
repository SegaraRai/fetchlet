import fetchletVinext from "@fetchlet/vinext";
import vinext from "vinext";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [vinext(), fetchletVinext({ backend: "quickjs" })],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      serve: {
        command: "pwsh -NoProfile -File ../../tools/cargo.ps1 run --locked -p example-vinext-axum",
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

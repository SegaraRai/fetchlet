import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import fetchletStart from "fetchlet/tanstack-start";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    tanstackStart(),
    react(),
    fetchletStart({
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
      assets: true,
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-tanstack-start-axum",
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

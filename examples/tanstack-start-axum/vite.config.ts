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
      // Keeps `vp build --watch` running while the server reloads each build.
      dev: {
        command: `fetchlet dev --build-watch "vp build --watch" -- node ../../tools/workspace/cargo.ts run --locked -p example-tanstack-start-axum --features dev`,
        cache: false,
      },
      // Runs the server entry from `vite dev` on the engine, without a build.
      "dev:vite": {
        command: `fetchlet dev --vite "vp dev" -- node ../../tools/workspace/cargo.ts run --locked -p example-tanstack-start-axum --features vite-dev`,
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

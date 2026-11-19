import { solidStart } from "@solidjs/start/config";
import fetchletSolidStart from "fetchlet/solid-start";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    solidStart(),
    fetchletSolidStart({
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
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-solidstart-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the server reloads each build.
      dev: {
        command:
          "node ../../tools/examples/dev.ts example-solidstart-axum src public vite.config.ts",
        dependsOn: ["build"],
        cache: false,
      },
      // Runs the server entry from `vite dev` on the engine.
      "dev:vite": {
        command: "node ../../tools/examples/vite-dev.ts example-solidstart-axum 3601",
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

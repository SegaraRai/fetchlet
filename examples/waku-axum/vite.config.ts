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
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-waku-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the server reloads each build.
      dev: {
        command: "node ../../tools/examples/dev.ts example-waku-axum src public vite.config.ts",
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

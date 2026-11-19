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
        command: `fetchlet dev --watch src --watch public --watch vite.config.ts --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-waku-axum --features dev`,
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        cache: false,
      },
    },
  },
});

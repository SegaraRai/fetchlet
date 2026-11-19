import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: { command: "astro build", cache: false },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-astro-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the server reloads each build.
      dev: {
        command: `fetchlet dev --watch web --watch astro.config.ts --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-astro-axum --features dev`,
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

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
      // Runs Astro's development app from `astro dev` on the engine, without a build.
      "dev:vite": {
        command: "node ../../tools/examples/vite-dev.ts example-astro-axum 3101",
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

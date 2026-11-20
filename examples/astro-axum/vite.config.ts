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
        command: `fetchlet dev --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-astro-axum --features dev`,
        cache: false,
      },
      // Runs Astro's development app from `astro dev` on the engine, without a build.
      "dev:vite": {
        command: `fetchlet dev --vite "vp exec astro dev" -- node ../../tools/workspace/cargo.ts run --locked -p example-astro-axum --features vite-dev`,
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

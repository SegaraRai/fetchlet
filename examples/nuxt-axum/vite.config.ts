import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: { command: "nuxt build", cache: false },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-nuxt-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the server reloads each build.
      dev: {
        command: `fetchlet dev --watch web --watch nuxt.config.ts --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-nuxt-axum --features dev`,
        cache: false,
      },
      "check:types": {
        command: "nuxt typecheck",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

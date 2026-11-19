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
        command: "node ../../tools/examples/dev.ts example-nuxt-axum web nuxt.config.ts",
        dependsOn: ["build"],
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

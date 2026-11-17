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
      "check:types": {
        command: "nuxt typecheck",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

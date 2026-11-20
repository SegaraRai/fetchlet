import fetchlet from "fetchlet/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    fetchlet({
      server: "src/server.ts",
      client: "src/client.ts",
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
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-vanilla-axum",
        dependsOn: ["build"],
        cache: false,
      },
      dev: {
        command: `fetchlet dev --build-watch "vp build --watch" -- node ../../tools/workspace/cargo.ts run --locked -p example-vanilla-axum --features dev`,
        cache: false,
      },
      "dev:vite": {
        command: `fetchlet dev --vite "vp dev" -- node ../../tools/workspace/cargo.ts run --locked -p example-vanilla-axum --features vite-dev`,
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        cache: false,
      },
    },
  },
});

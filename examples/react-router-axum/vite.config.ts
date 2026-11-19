import { reactRouter } from "@react-router/dev/vite";
import { fetchletDevServer } from "fetchlet/react-router";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    reactRouter(),
    fetchletDevServer({
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "react-router build",
        cache: false,
      },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-react-router-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the server reloads each build.
      dev: {
        command:
          "node ../../tools/examples/dev.ts example-react-router-axum app public react-router.config.ts vite.config.ts",
        dependsOn: ["build"],
        cache: false,
      },
      // Runs the server build from `vite dev` on the engine.
      "dev:vite": {
        command: "node ../../tools/examples/vite-dev.ts example-react-router-axum 3301",
        cache: false,
      },
      "check:types": {
        command: "react-router typegen && tsc --noEmit",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

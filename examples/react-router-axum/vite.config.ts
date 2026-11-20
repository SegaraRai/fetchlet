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
        command: `fetchlet dev --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-react-router-axum --features dev`,
        cache: false,
      },
      // Runs the server build from `vite dev` on the engine.
      "dev:vite": {
        command: `fetchlet dev --vite "vp dev" -- node ../../tools/workspace/cargo.ts run --locked -p example-react-router-axum --features vite-dev`,
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

import fetchletVinext from "fetchlet/vinext";
import vinext from "vinext";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    vinext(),
    fetchletVinext({
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
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-vinext-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the server reloads each build.
      dev: {
        command: `fetchlet dev --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-vinext-axum --features dev`,
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        cache: false,
      },
    },
  },
});

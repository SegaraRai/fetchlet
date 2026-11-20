import solid from "@solidjs/vite-plugin";
import fetchletSolid from "fetchlet/solid";
import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    solid({
      start: { middleware: "./src/middleware.ts" },
      ssr: true,
      extensions: [".jsx", ".tsx"],
    }),
    fileRoutes({ httpMethods: true, types: true }),
    fetchletSolid({
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
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-solid-axum",
        dependsOn: ["build"],
        cache: false,
      },
      // Keeps `vp build --watch` running while the server reloads each build.
      dev: {
        command: `fetchlet dev --build-watch "vp build --watch" -- node ../../tools/workspace/cargo.ts run --locked -p example-solid-axum --features dev`,
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

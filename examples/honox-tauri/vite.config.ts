import fetchletBuild from "fetchlet/hono/vite";
import honox from "honox/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    // `--mode client` writes browser assets here; the server build reads the manifest.
    outDir: "build/client",
  },
  plugins: [
    honox({ client: { input: ["/app/client.ts", "/app/style.css"] } }),
    fetchletBuild({
      entry: "./app/server.ts",
      functions: "./app/functions.ts",
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build --mode client && vp build",
        cache: false,
      },
      app: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-honox-tauri",
        dependsOn: ["build"],
        cache: false,
      },
      // Rebuilds on source changes while the app reloads each build.
      dev: {
        command: `fetchlet dev --watch app --watch public --watch vite.config.ts --build "vp run build" -- node ../../tools/workspace/cargo.ts run --locked -p example-honox-tauri --features dev`,
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

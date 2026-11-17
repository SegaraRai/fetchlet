import { IMMUTABLE } from "fetchlet/build";
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
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
      assets: {
        // HonoX names its client build output after its contents.
        cache: [{ prefix: "/static/", cacheControl: IMMUTABLE }],
      },
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build --mode client && vp build",
        cache: false,
      },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-honox-axum",
        dependsOn: ["build"],
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

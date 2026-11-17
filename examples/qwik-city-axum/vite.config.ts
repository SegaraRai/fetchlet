import { qwikVite } from "@builder.io/qwik/optimizer";
import { qwikCity } from "@builder.io/qwik-city/vite";
import { fetchletAdapter } from "fetchlet/qwik-city/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    qwikCity(),
    qwikVite({
      client: { outDir: "build/client" },
      ssr: { outDir: "node_modules/.cache/fetchlet-qwik-city" },
    }),
    fetchletAdapter({
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
      assets: true,
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build && vp build --ssr",
        cache: false,
      },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-qwik-city-axum",
        dependsOn: ["build"],
        cache: false,
      },
      "check:types": {
        command: "tsc --noEmit",
        cache: false,
      },
    },
  },
});

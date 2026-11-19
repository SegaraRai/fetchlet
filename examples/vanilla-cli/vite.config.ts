import fetchlet from "fetchlet/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    fetchlet({
      server: "src/functions.ts",
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      start: {
        command:
          "node ../../tools/workspace/cargo.ts run --locked -p example-vanilla-cli -- greet Rust",
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

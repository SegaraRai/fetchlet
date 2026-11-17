import fetchletSolidStart from "fetchlet/solid-start";
import { solidStart } from "@solidjs/start/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    solidStart(),
    fetchletSolidStart({
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
    }),
  ],
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: false,
      },
      serve: {
        command: "node ../../tools/workspace/cargo.ts run --locked -p example-solidstart-axum",
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

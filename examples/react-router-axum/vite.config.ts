import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [reactRouter()],
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
      "check:types": {
        command: "react-router typegen && tsc --noEmit",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});

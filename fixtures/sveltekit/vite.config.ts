import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: { experimental: { async: false } },
      adapter: {
        name: "fetchlet-lab",
        async adapt(builder) {
          const out = resolve("build");
          mkdirSync(out, { recursive: true });
          builder.writeServer(out + "/server");
          builder.generateServerInstance(out + "/server-instance.js", {
            serverDirectory: out + "/server",
          });
          builder.writeClient(out + "/client");
        },
      },
    }),
  ],
});

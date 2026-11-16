// Nitro loads this file when an app sets `preset: "@fetchlet/nitro-preset"`.

import { fileURLToPath } from "node:url";
import { defineNitroPreset } from "nitropack/kit";
import { writeArtifact } from "./src/artifact.mjs";

export default defineNitroPreset(
  {
    extends: "base-worker",
    entry: fileURLToPath(new URL("./src/runtime/nitro.mjs", import.meta.url)),
    // The Rust server serves public assets; Nitro answers everything else.
    serveStatic: false,
    minify: false,
    // The same language level as the final bundle.
    esbuild: {
      options: {
        target: "es2022",
      },
    },
    output: {
      dir: "{{ rootDir }}/build",
      publicDir: "{{ output.dir }}/client",
      serverDir: "{{ buildDir }}/fetchlet/server",
    },
    // @fetchlet/build bundles this module again after the Web API profile.
    rollupConfig: {
      output: {
        format: "esm",
        entryFileNames: "index.mjs",
      },
    },
    hooks: {
      compiled: writeArtifact,
    },
  },
  {
    name: "fetchlet",
    url: import.meta.url,
  },
);

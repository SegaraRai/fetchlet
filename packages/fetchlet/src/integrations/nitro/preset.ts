// Nitro loads this file when an app sets `preset: "fetchlet/nitro"`.

import { createRequire } from "node:module";

import type { NitroPreset, NitroPresetMeta } from "nitropack/types";

import { writeArtifact } from "./artifact.ts";

/**
 * The Nitro preset; apps select it with `preset: "fetchlet/nitro"`. It is the
 * object `defineNitroPreset` from nitropack/kit returns, written out: Nitro
 * loads TypeScript presets through jiti as CommonJS, and nitropack/kit is ESM
 * only.
 */
const preset: NitroPreset & { _meta: NitroPresetMeta } = {
  extends: "base-worker",
  entry: createRequire(import.meta.url).resolve("fetchlet/nitro/runtime"),
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
  // fetchlet/build bundles this module again after the Web API profile.
  rollupConfig: {
    output: {
      format: "esm",
      entryFileNames: "index.mjs",
    },
  },
  hooks: {
    compiled: writeArtifact,
  },
  _meta: {
    name: "fetchlet",
    url: import.meta.url,
  },
};

export default preset;

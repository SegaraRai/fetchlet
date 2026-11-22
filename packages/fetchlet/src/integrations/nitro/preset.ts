// Nitro loads this file when an app sets `preset: "fetchlet/nitro"`.

import { createRequire } from "node:module";

import type { NitroPreset, NitroPresetMeta } from "nitropack/types";

import { implementedNodeBuiltins, nodeGlobals } from "../../build/node-builtins.ts";
import { writeArtifact } from "./artifact.ts";
import { websocketUpgrades } from "./websocket.ts";

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
  // The Node built-ins fetchlet implements stay imports for fetchlet/build to
  // resolve, in place of unenv's, and so do the globals that reference them.
  unenv: {
    meta: {
      name: "fetchlet:node-builtins",
    },
    external: implementedNodeBuiltins.filter((name) => name.startsWith("node:")),
    alias: Object.fromEntries(
      implementedNodeBuiltins.map((name) => [
        name,
        name.startsWith("node:") ? name : `node:${name}`,
      ]),
    ),
    inject: nodeGlobals,
  },
  // fetchlet/build bundles this module again after the Web API profile.
  rollupConfig: {
    output: {
      format: "esm",
      entryFileNames: "index.mjs",
    },
  },
  hooks: {
    "rollup:before": websocketUpgrades,
    compiled: writeArtifact,
  },
  _meta: {
    name: "fetchlet",
    url: import.meta.url,
  },
};

export default preset;

import { createRequire } from "node:module";

import type { Plugin } from "rolldown";

const require = createRequire(import.meta.url);

const shim = (name: string): string => require.resolve("fetchlet/vinext/node/" + name);

const shims: Record<string, string> = {
  "node:fs": shim("fs"),
  fs: shim("fs"),
};

const moduleModule = "\0fetchlet:vinext-module";

/** `process.env` is empty and `process.platform` is "linux" at build time. */
export const vinextNodeDefines = {
  "process.env": "{}",
  "process.platform": JSON.stringify("linux"),
};

/**
 * The Node APIs the vinext server build reaches while it loads and renders,
 * mapped onto Web-standard code. vinext targets Cloudflare Workers with
 * nodejs_compat; fetchlet engines provide Web APIs only.
 *
 * - `node:path` is pathe, which implements posix and win32 paths in plain JS.
 * - `node:fs` reports that no file exists: the artifact reads no files, and
 *   vinext falls back to its in-memory caches without them.
 * - `node:buffer` and `node:crypto`, which vinext uses for cache keys, are
 *   fetchlet's own, as for every artifact.
 * - `node:module` creates a `require` for the React entries, which vinext
 *   keeps external in its SSR build and requires from CommonJS modules. Other
 *   specifiers throw.
 */
export function vinextNodeCompat(): Plugin {
  return {
    name: "fetchlet/vinext:node-compat",
    resolveId(source) {
      if (source === "node:path" || source === "path") {
        return require.resolve("pathe");
      }
      if (Object.hasOwn(shims, source)) {
        return shims[source];
      }
      if (source === "node:module" || source === "module") {
        return moduleModule;
      }
    },
    load(id) {
      if (id === moduleModule) {
        return `
          import * as react from "react";
          import * as reactDom from "react-dom";
          import * as reactDomServer from "react-dom/server";
          import * as jsxRuntime from "react/jsx-runtime";

          const modules = {
            react,
            "react-dom": reactDom,
            "react-dom/server": reactDomServer,
            "react/jsx-runtime": jsxRuntime,
          };

          export const createRequire = () => (specifier) => {
            const namespace = modules[specifier];
            if (!namespace) {
              throw new Error("require(" + JSON.stringify(specifier) + ") is not available in fetchlet");
            }
            return namespace.default ?? namespace;
          };

          export default { createRequire };
        `;
      }
    },
  };
}

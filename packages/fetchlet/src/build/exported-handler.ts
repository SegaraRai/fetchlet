// The artifact entry around a module in the Workers module format:
// `export default { fetch(request, env, ctx) }` beside named functions, or
// named functions alone.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import type { Plugin } from "rolldown";

import type { EntrySource } from "./index.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

// The package resolves itself, so the entry builds wherever the module is.
const adapter = createRequire(import.meta.url).resolve("fetchlet/runtime/adapter");

// The import that `exportedHandlerPlugin` replaces with the entry around the
// module, once it knows whether the module has a default export.
const specifierPrefix = "fetchlet:exported-handler:";
const virtualPrefix = "\0" + specifierPrefix;

/** The export name of the artifact's Fetch handler. */
const HANDLER = "handle";

/**
 * The entry of an artifact whose server module has the Workers module shape.
 * Its default export's `fetch(request, env, ctx)` becomes the artifact's
 * Fetch handler, with the host bindings as `env` and `waitUntil` and the
 * client address on `ctx`; its named exports stay callable from Rust with
 * `App::call`. A module without a default export builds an artifact of
 * functions only, whose manifest records no handler. The export name
 * `handle` is reserved for the handler.
 *
 * ```ts
 * await buildArtifact({
 *   entry: exportedHandler("./src/server.ts"),
 *   outDir: "build",
 * });
 * ```
 */
export function exportedHandler(module: string): EntrySource {
  const file = resolve(module);
  return {
    resolveDir: dirname(file),
    source: exportedHandlerSource(file),
  };
}

/** The entry source for `exportedHandler`, around the module at `file`. */
export function exportedHandlerSource(file: string): string {
  return `export * from ${JSON.stringify(specifierPrefix + modulePath(file))};\n`;
}

/**
 * Builds the entry `exportedHandlerSource` refers to: the module's named
 * exports, with a Fetch handler when the module has a default export.
 */
export function exportedHandlerPlugin(): Plugin {
  return {
    name: "fetchlet:exported-handler",
    resolveId(id) {
      if (id.startsWith(specifierPrefix)) {
        return "\0" + id;
      }
    },
    async load(id) {
      if (!id.startsWith(virtualPrefix)) {
        return;
      }
      const file = id.slice(virtualPrefix.length);
      const resolved = await this.resolve(file);
      if (!resolved) {
        return this.error(`Could not resolve the server module ${file}`);
      }
      const { exports } = await this.load({ id: resolved.id });
      if (exports.includes(HANDLER)) {
        return this.error(
          `The server module ${file} exports "${HANDLER}", which is reserved for the Fetch handler`,
        );
      }
      const specifier = JSON.stringify(modulePath(resolved.id));
      const reexport = `export * from ${specifier};`;
      if (!exports.includes("default")) {
        return reexport;
      }
      return `
        import { createFetchHandler, getBindings, waitUntil } from ${JSON.stringify(modulePath(adapter))};
        import server from ${specifier};

        ${reexport}

        export const ${HANDLER} = createFetchHandler((request, context = {}) => {
          if (typeof server?.fetch !== "function") {
            throw new TypeError("The server module's default export has no fetch method");
          }
          return server.fetch(request, getBindings(), {
            waitUntil,
            passThroughOnException() {},
            props: {},
            clientAddress: context.clientAddress,
          });
        });
      `;
    },
  };
}

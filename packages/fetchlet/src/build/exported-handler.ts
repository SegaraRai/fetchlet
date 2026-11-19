// The artifact entry around a module in the Workers module format:
// `export default { fetch(request, env, ctx) }` beside named functions.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import type { EntrySource } from "./index.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

// The package resolves itself, so the entry builds wherever the module is.
const adapter = createRequire(import.meta.url).resolve("fetchlet/runtime/adapter");

/**
 * The entry of an artifact whose server module has the Workers module shape.
 * Its default export's `fetch(request, env, ctx)` becomes the artifact's
 * Fetch handler, with the host bindings as `env` and `waitUntil` and the
 * client address on `ctx`; its named exports stay callable from Rust with
 * `App::call`. The export name `handle` is reserved for the handler.
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
  const specifier = JSON.stringify(modulePath(file));
  return `
    import { createFetchHandler, getBindings, waitUntil } from ${JSON.stringify(modulePath(adapter))};
    import * as server from ${specifier};

    export * from ${specifier};

    export const handle = createFetchHandler((request, context = {}) => {
      const handler = server.default;
      if (typeof handler?.fetch !== "function") {
        throw new TypeError("The server module has no default export with a fetch method");
      }
      return handler.fetch(request, getBindings(), {
        waitUntil,
        passThroughOnException() {},
        props: {},
        clientAddress: context.clientAddress,
      });
    });
  `;
}

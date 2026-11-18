import { createRequire, isBuiltin } from "node:module";

import type { Plugin } from "rolldown";

const require = createRequire(import.meta.url);

/** How an artifact provides node:async_hooks. */
export type AsyncContextMode = "serialized" | "propagated";

/**
 * The Node built-in modules that fetchlet implements, by name without the
 * `node:` scheme, with the fetchlet subpath of each. node:async_hooks
 * depends on the build's asyncContext option and is listed separately.
 */
const modules: Record<string, string> = {
  assert: "fetchlet/node/assert",
  "assert/strict": "fetchlet/node/assert/strict",
  buffer: "fetchlet/node/buffer",
  crypto: "fetchlet/node/crypto",
  diagnostics_channel: "fetchlet/node/diagnostics-channel",
  events: "fetchlet/node/events",
  http: "fetchlet/node/http",
  https: "fetchlet/node/https",
  path: "fetchlet/node/path",
  "path/posix": "fetchlet/node/path",
  process: "fetchlet/node/process",
  querystring: "fetchlet/node/querystring",
  stream: "fetchlet/node/stream",
  "stream/promises": "fetchlet/node/stream/promises",
  "stream/web": "fetchlet/node/stream/web",
  string_decoder: "fetchlet/node/string-decoder",
  timers: "fetchlet/node/timers",
  "timers/promises": "fetchlet/node/timers/promises",
  url: "fetchlet/node/url",
  util: "fetchlet/node/util",
  "util/types": "fetchlet/node/util/types",
  zlib: "fetchlet/node/zlib",
};

const asyncHooksModules: Record<AsyncContextMode, string> = {
  propagated: "fetchlet/node/async-hooks",
  serialized: "fetchlet/node/async-hooks/serialized",
};

/** Names, with and without `node:`, that fetchlet/build resolves to its own modules. */
export const implementedNodeBuiltins: readonly string[] = [...Object.keys(modules), "async_hooks"]
  .flatMap((name) => [name, `node:${name}`])
  .sort();

/**
 * Globals that Node defines and the Web API profile does not. A module that
 * references one imports it from the implementing module instead, so the
 * globals cost nothing where they are unused.
 */
export const nodeGlobals: Record<string, string | [string, string]> = {
  Buffer: ["node:buffer", "Buffer"],
  process: "node:process",
  setImmediate: ["node:timers", "setImmediate"],
  clearImmediate: ["node:timers", "clearImmediate"],
};

/**
 * Specifiers that name the npm polyfill of a built-in by its directory.
 * readable-stream, which node:stream is built on, requires these; the
 * artifact's own modules serve them.
 */
const polyfillNames: Record<string, string> = {
  "process/": "process",
  "string_decoder/": "string_decoder",
};

const requirePrefix = "\0fetchlet:node-require:";
const stubPrefix = "\0fetchlet:node-stub:";

/**
 * A module whose members can be read, destructured and extended at load
 * time, and that throws ERR_METHOD_NOT_IMPLEMENTED when any of them is
 * called or constructed. Code that only references the module on paths
 * fetchlet never takes still loads; code that uses it fails where it runs,
 * naming what it called.
 */
function stubSource(name: string, hint: string): string {
  return `
    const fail = (path) => () => {
      const error = new Error(path + " is not available in fetchlet" + ${JSON.stringify(hint)});
      error.code = "ERR_METHOD_NOT_IMPLEMENTED";
      throw error;
    };
    const stub = (path) =>
      new Proxy(function () {}, {
        get(target, key) {
          if (typeof key === "symbol" || key === "then" || key === "__esModule") {
            return undefined;
          }
          if (key === "prototype") {
            return target.prototype;
          }
          return stub(path + "." + key);
        },
        apply: fail(path),
        construct: fail(path),
      });
    module.exports = stub(${JSON.stringify(name)});
  `;
}

/**
 * Node built-ins for the artifact.
 *
 * The modules fetchlet implements resolve to fetchlet/node/*. A `require`
 * gets the module's default export, which holds all its members as Node's
 * CommonJS exports do; for node:events that is the EventEmitter class.
 * node:async_hooks is the module for `asyncContext`, see AsyncContextMode.
 *
 * Other built-ins resolve to an npm package of the same name when the name
 * is bare and one is installed, and otherwise to a stub that throws when it
 * is used. Adapter plugins run first and may provide any of them.
 */
export function nodeBuiltins(asyncContext?: AsyncContextMode): Plugin {
  const implementation = (name: string): string | undefined => {
    if (name === "async_hooks") {
      return asyncContext && require.resolve(asyncHooksModules[asyncContext]);
    }
    const subpath = Object.hasOwn(modules, name) ? modules[name] : undefined;
    return subpath && require.resolve(subpath);
  };
  return {
    name: "fetchlet:node-builtins",
    async resolveId(id, importer, options) {
      const polyfill = Object.hasOwn(polyfillNames, id) ? polyfillNames[id] : undefined;
      if (!polyfill && !isBuiltin(id)) {
        return;
      }
      const name = polyfill ?? (id.startsWith("node:") ? id.slice("node:".length) : id);
      const file = implementation(name);
      if (file) {
        return options.kind === "require-call" ? requirePrefix + file : file;
      }
      // Bare names such as "string_decoder" may be npm packages of the same name.
      if (!id.startsWith("node:")) {
        const resolved = await this.resolve(id, importer, {
          ...options,
          skipSelf: true,
        });
        if (resolved && !resolved.external) {
          return resolved;
        }
      }
      return stubPrefix + name;
    },
    load(id) {
      if (id.startsWith(requirePrefix)) {
        const file = id.slice(requirePrefix.length);
        return {
          code: `module.exports = require(${JSON.stringify(file)}).default;`,
          moduleType: "js",
        };
      }
      if (id.startsWith(stubPrefix)) {
        const name = id.slice(stubPrefix.length);
        const hint =
          name === "async_hooks" ? "; build with the asyncContext option to provide it" : "";
        return {
          code: stubSource(`node:${name}`, hint),
          moduleType: "js",
        };
      }
    },
  };
}

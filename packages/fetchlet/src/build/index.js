import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, resolve } from "node:path";

import { build } from "rolldown";

import { serializedAsyncContext } from "./async-context.js";
import { nativeCapabilityCheck } from "./polyfills/bootstrap.js";
import { planPolyfills } from "./polyfills/plan.js";

// The Web API profile, initialized before the framework modules. The package
// resolves itself: the source in the workspace, the compiled module when published.
// createRequire works in Vite's module runner, which lacks import.meta.resolve.
const runtimeEntry = createRequire(import.meta.url).resolve("fetchlet/runtime");

const modulePath = (file) => file.replaceAll("\\", "/");

const entryId = "\0fetchlet:entry";
const nativeCheckId = "\0fetchlet:native-check";
const nodeBuiltinPrefix = "\0fetchlet:node-builtin:";

/**
 * The artifact entry as virtual modules: it imports the Web API profile, the
 * planned polyfills and the native capability check, then reexports the
 * framework's server entry.
 */
function artifactEntry(input, plan) {
  return {
    name: "fetchlet:artifact-entry",
    resolveId(id) {
      if (id === entryId || id === nativeCheckId) {
        return id;
      }
    },
    load(id) {
      if (id === entryId) {
        return [runtimeEntry, ...plan.imports, nativeCheckId]
          .map((file) => `import ${JSON.stringify(modulePath(file))};`)
          .concat(`export * from ${JSON.stringify(modulePath(input))};`)
          .join("\n");
      }
      if (id === nativeCheckId) {
        return nativeCapabilityCheck(plan);
      }
    },
  };
}

/**
 * Node built-ins that neither an adapter shim nor an npm package of the same
 * name provides become empty CommonJS modules, as Vite's browser build makes
 * them: engines have no Node APIs, so code that only references them on paths
 * fetchlet never takes still loads, and code that calls them fails where it
 * runs.
 */
function emptyNodeBuiltins() {
  return {
    name: "fetchlet:empty-node-builtins",
    async resolveId(id, importer, options) {
      if (!isBuiltin(id)) {
        return;
      }
      // Bare names such as "buffer" may be npm packages of the same name.
      if (!id.startsWith("node:")) {
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
        if (resolved && !resolved.external) {
          return resolved;
        }
      }
      return nodeBuiltinPrefix + id;
    },
    load(id) {
      if (id.startsWith(nodeBuiltinPrefix)) {
        return {
          code: "module.exports = {};",
          moduleType: "js",
        };
      }
    },
  };
}

/** Initialize the Web API profile before evaluating framework modules. */
export async function buildArtifact({
  entry,
  outDir,
  plugins = [],
  framework,
  rendering,
  requirements = [],
  backend = "portable",
  intl = {},
  asyncContext,
  conditions = [],
  define = {},
}) {
  const plan = planPolyfills({ backend, requirements, intl });
  const output = resolve(outDir);
  mkdirSync(output, { recursive: true });
  await build({
    input: entryId,
    platform: "neutral",
    resolve: {
      mainFields: ["module", "main"],
      // Adapters add conditions for dependencies a framework left external,
      // such as "workerd" for react-dom/server.edge.
      conditionNames: [...conditions, "module", "production", "import", "default"],
    },
    plugins: [
      artifactEntry(resolve(entry), plan),
      ...(asyncContext === "serialized" ? [serializedAsyncContext()] : []),
      ...plugins,
      emptyNodeBuiltins(),
    ],
    transform: {
      target: "es2022",
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
        ...define,
      },
    },
    output: {
      file: join(output, "server.js"),
      format: "iife",
      name: "fetchletExports",
      codeSplitting: false,
      // Remove dead code without mangling, so artifacts stay readable.
      minify: "dce-only",
      topLevelVar: true,
    },
  });
  writeFileSync(
    join(output, "fetchlet.json"),
    JSON.stringify(
      {
        format: "fetchlet-iife",
        formatVersion: 1,
        handler: "handle",
        server: "server.js",
        client: "client",
        profile: "portable-web",
        framework,
        rendering,
        ...(asyncContext ? { asyncContext } : {}),
        requirements: plan.requirements,
        backend: plan.backend,
        nativeRequirements: plan.nativeRequirements,
        polyfills: plan.polyfills,
        intl: plan.intl,
      },
      null,
      2,
    ) + "\n",
  );
}

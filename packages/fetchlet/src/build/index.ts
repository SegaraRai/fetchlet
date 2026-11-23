import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { build, type Plugin } from "rolldown";

import { archiveAssets, type AssetsOption } from "./asset-option.ts";
import { runtimeConditions } from "./conditions.ts";
import { exportedHandlerPlugin } from "./exported-handler.ts";
import { writeManifest } from "./manifest.ts";
import { type AsyncContextMode, nodeBuiltins, nodeGlobals } from "./node-builtins.ts";
import { nativeCapabilityCheck } from "./polyfills/bootstrap.ts";
import {
  planPolyfills,
  type BuildBackend,
  type IntlOptions,
  type PolyfillPlan,
} from "./polyfills/plan.ts";

export {
  writeAssetArchive,
  type AssetArchiveSummary,
  type AssetBody,
  type AssetEntry,
  type WriteAssetArchiveOptions,
} from "./asset-archive.ts";
export {
  contentType,
  defaultAssetInclude,
  directoryAssets,
  IMMUTABLE,
  redirect,
  type AssetInclude,
  type AssetInfo,
  type AssetPathInfo,
  type AssetResponder,
  type AssetRoutes,
  type CacheRule,
  type DirectoryAssetOptions,
} from "./asset-entries.ts";
export {
  archiveArtifactAssets,
  type ArchiveArtifactAssetsOptions,
  type AssetContext,
  type AssetEntriesFunction,
  type AssetSettings,
  type AssetsOption,
} from "./asset-option.ts";
export { runtimeConditions, runtimeKey } from "./conditions.ts";
export { exportedHandler } from "./exported-handler.ts";
export { implementedNodeBuiltins, type AsyncContextMode } from "./node-builtins.ts";
export type { BuildBackend, IntlOptions } from "./polyfills/plan.ts";

/** An entry module given as source instead of a file. */
export interface EntrySource {
  /** The module's source. */
  source: string;
  /** The directory its relative and package imports resolve from. */
  resolveDir: string;
}

export interface BuildArtifactOptions {
  /**
   * The server entry, which exports the Fetch handler `handle` and any
   * functions: a module path, or the module's source with the directory its
   * imports resolve from. Adapters pass the glue around a framework's server
   * build as source, so nothing is written to disk. An entry without
   * `handle` builds an artifact of functions only.
   */
  entry: string | EntrySource;
  /** The artifact directory; `server.js` and `fetchlet.json` are written here. */
  outDir: string;
  /** Rolldown plugins, after fetchlet's own. */
  plugins?: Plugin[];
  /** Recorded in fetchlet.json. */
  framework?: string;
  /** The framework's rendering profile, recorded in fetchlet.json. */
  rendering?: string;
  /** APIs the application requires beyond the portable profile. */
  requirements?: string[];
  backend?: BuildBackend;
  intl?: IntlOptions;
  /**
   * Provides `node:async_hooks`. `"propagated"` carries the context through
   * promise reactions on engines with an async context slot (V8 and Boa);
   * `"serialized"` keeps one context at a time and runs on every engine.
   * Without it, node:async_hooks throws when used. Recorded in fetchlet.json.
   */
  asyncContext?: AsyncContextMode;
  /**
   * Conditions added to fetchlet's runtime conditions for dependencies a
   * framework left external.
   */
  conditions?: string[];
  /** Global replacements, in addition to `process.env.NODE_ENV`. */
  define?: Record<string, string>;
  /**
   * Archive the client directory as `assets.flpk` after the build, for
   * adapters that wrote it before calling `buildArtifact`. Others call
   * `archiveArtifactAssets` once the directory is complete.
   */
  assets?: AssetsOption;
}

// The Web API profile, initialized before the framework modules. The package
// resolves itself: the source in the workspace, the compiled module when published.
// createRequire works in Vite's module runner, which lacks import.meta.resolve.
const runtimeEntry = createRequire(import.meta.url).resolve("fetchlet/runtime");

const modulePath = (file: string): string => file.replaceAll("\\", "/");

const entryId = "\0fetchlet:entry";
/** The export name of the artifact's Fetch handler. */
const HANDLER = "handle";
// The file name of an entry given as source; it is never read or written.
const sourceEntryName = "fetchlet-entry.js";
const nativeCheckId = "\0fetchlet:native-check";

/**
 * The artifact entry as virtual modules: it imports the Web API profile, the
 * planned polyfills and the native capability check, then reexports the
 * framework's server entry.
 */
function artifactEntry(input: string, plan: PolyfillPlan, source?: string): Plugin {
  return {
    name: "fetchlet:artifact-entry",
    resolveId(id, importer) {
      if (id === entryId || id === nativeCheckId) {
        return id;
      }
      if (source !== undefined && importer === entryId && resolve(id) === input) {
        return input;
      }
    },
    load(id) {
      if (source !== undefined && id === input) {
        return {
          code: source,
          moduleType: "js",
        };
      }
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
  assets,
}: BuildArtifactOptions): Promise<void> {
  const plan = planPolyfills({ backend, requirements, intl });
  const output = resolve(outDir);
  mkdirSync(output, { recursive: true });
  const { output: chunks } = await build({
    input: entryId,
    platform: "neutral",
    resolve: {
      mainFields: ["module", "main"],
      // Adapters add conditions for dependencies a framework left external,
      // such as "workerd" for the edge builds of React's server packages.
      conditionNames: [...conditions, ...runtimeConditions()],
    },
    plugins: [
      typeof entry === "string"
        ? artifactEntry(resolve(entry), plan)
        : artifactEntry(join(resolve(entry.resolveDir), sourceEntryName), plan, entry.source),
      exportedHandlerPlugin(),
      ...plugins,
      nodeBuiltins(asyncContext),
    ],
    transform: {
      target: "es2022",
      inject: nodeGlobals,
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
  // The entry chunk's exports: the Fetch handler, when there is one, and the
  // functions Rust calls with App::call.
  const exports = chunks[0].exports;
  const manifest = {
    format: "fetchlet-iife",
    formatVersion: 1,
    handler: exports.includes(HANDLER) ? HANDLER : null,
    functions: exports.filter((name) => name !== HANDLER).sort(),
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
  };
  const manifestPath = join(output, "fetchlet.json");
  if (assets) {
    await archiveAssets(output, manifest, assets, manifestPath);
  }
  // Last, so the files it names are complete when a reader sees it.
  writeManifest(manifestPath, manifest);
}

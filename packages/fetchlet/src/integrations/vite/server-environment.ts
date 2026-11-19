// The Vite plugin shape every fetchlet integration built on Vite environments
// shares: the client build goes to `<outDir>/client`, the server environment
// to a cache directory, and once the server bundle is written, its entry is
// wrapped by the integration's glue and bundled into the artifact.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { EnvironmentOptions, Plugin, Rolldown } from "vite";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import {
  frameworkAssets,
  type AssetsOption,
  type FrameworkAssetDefaults,
} from "../../build/asset-option.ts";
import {
  buildArtifact,
  type AsyncContextMode,
  type BuildBackend,
  type IntlOptions,
} from "../../build/index.ts";

/** The options every Vite-based integration takes from the app. */
export interface ViteArtifactOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` caches the hashed files under Vite's
   * `build.assetsDir` for a year; settings adjust those defaults and add
   * entries, and a function returns every entry. See docs/asset-archive.md.
   */
  assets?: AssetsOption;
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

/** What an integration adds to the shared plugin. */
export interface ServerEnvironmentIntegration {
  /** The plugin name, such as `fetchlet/solid`. */
  name: string;
  /** Recorded in fetchlet.json. */
  framework: string;
  /** The rendering profile, recorded in fetchlet.json. */
  rendering: string;
  /** How `node:async_hooks` is provided; see fetchlet/build. */
  asyncContext?: AsyncContextMode;
  /** The name of the environment whose bundle holds the server. Defaults to "ssr". */
  environment?: string;
  /** Picks the server entry among the environment's entry chunks; the first by default. */
  isServerEntry?: (chunk: Rolldown.OutputChunk) => boolean;
  /** Options for the server environment, merged over the shared ones. */
  serverEnvironment?: EnvironmentOptions;
  /** The artifact entry source around the built server module. */
  entrySource(serverModule: string): string;
  /** Asset defaults beyond the hashed files under `build.assetsDir`. */
  assetDefaults?: FrameworkAssetDefaults;
}

const modulePath = (file: string): string => file.replaceAll("\\", "/");

/** A module path for generated source, with forward slashes on every platform. */
export const importPath = (file: string): string => JSON.stringify(modulePath(file));

/** The plugin that builds an integration's server environment into an artifact. */
export function serverEnvironmentPlugin(
  integration: ServerEnvironmentIntegration,
  { outDir = "build", backend = "portable", intl = {}, assets = false }: ViteArtifactOptions,
): Plugin {
  const environmentName = integration.environment ?? "ssr";
  const cacheDirectory = "node_modules/.cache/" + integration.name.replaceAll("/", "-");
  let root = process.cwd();
  let assetPrefix = "/assets/";
  let serverDirectory: string | undefined;
  return {
    name: integration.name,
    config() {
      return {
        environments: {
          client: {
            build: {
              outDir: join(outDir, "client"),
            },
          },
          [environmentName]: mergeEnvironment(
            {
              // fetchlet/build bundles the output again for the engine, so
              // every dependency is resolved for a Web-standard server here.
              resolve: { noExternal: true },
              build: { outDir: cacheDirectory },
            },
            integration.serverEnvironment ?? {},
          ),
        },
      };
    },
    configResolved(config) {
      root = config.root;
      assetPrefix =
        (config.base.endsWith("/") ? config.base : config.base + "/") +
        config.build.assetsDir.replace(/^\/+|\/+$/g, "") +
        "/";
    },
    applyToEnvironment(environment) {
      return environment.name === environmentName;
    },
    configEnvironment(name, config) {
      if (name === environmentName) {
        serverDirectory = config.build?.outDir;
      }
    },
    async writeBundle(options, bundle) {
      const directory = resolve(root, options.dir ?? serverDirectory ?? cacheDirectory);
      const entries = Object.values(bundle).filter(
        (chunk): chunk is Rolldown.OutputChunk => chunk.type === "chunk" && chunk.isEntry,
      );
      const entry = entries.find(integration.isServerEntry ?? (() => true));
      const serverModule = entry && join(directory, entry.fileName);
      if (!serverModule || !existsSync(serverModule)) {
        throw new Error(`${integration.name} found no server entry in ${directory}`);
      }
      const defaults = integration.assetDefaults ?? {};
      await buildArtifact({
        entry: {
          source: integration.entrySource(serverModule),
          resolveDir: directory,
        },
        outDir: resolve(root, outDir),
        framework: integration.framework,
        rendering: integration.rendering,
        ...(integration.asyncContext ? { asyncContext: integration.asyncContext } : {}),
        backend,
        intl,
        ...(assets
          ? {
              assets: frameworkAssets(assets, {
                ...defaults,
                cache: [
                  ...(defaults.cache ?? []),
                  { prefix: assetPrefix, cacheControl: IMMUTABLE },
                ],
              }),
            }
          : {}),
      });
    },
  };
}

/** `base` with `override` on top, merging the nested objects the integrations set. */
function mergeEnvironment(
  base: EnvironmentOptions,
  override: EnvironmentOptions,
): EnvironmentOptions {
  return {
    ...base,
    ...override,
    resolve: { ...base.resolve, ...override.resolve },
    build: { ...base.build, ...override.build },
  };
}

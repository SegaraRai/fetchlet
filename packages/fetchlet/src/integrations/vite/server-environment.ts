// The Vite plugin shape every fetchlet integration built on Vite environments
// shares: the client build goes to `<outDir>/client`, the server environment
// to a cache directory, and once the server bundle is written, its entry is
// wrapped by the integration's glue and bundled into the artifact.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { EnvironmentOptions, Plugin, ResolvedConfig, Rolldown } from "vite";

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

/** What an integration puts around its framework's built server module. */
export interface ArtifactIntegration {
  /** The plugin name, such as `fetchlet/solid`. */
  name: string;
  /** Recorded in fetchlet.json. */
  framework: string;
  /** The rendering profile, recorded in fetchlet.json. */
  rendering: string;
  /** How `node:async_hooks` is provided; see fetchlet/build. */
  asyncContext?: AsyncContextMode;
  /** The artifact entry source around the built server module. */
  entrySource(serverModule: string): string;
  /** The framework's asset defaults, beneath the app's `assets` settings. */
  assetDefaults?: FrameworkAssetDefaults;
}

/** What an integration built on Vite environments adds to the shared plugin. */
export interface ServerEnvironmentIntegration extends ArtifactIntegration {
  /** The name of the environment whose bundle holds the server. Defaults to "ssr". */
  environment?: string;
  /** Picks the server entry among the environment's entry chunks; the first by default. */
  isServerEntry?: (chunk: Rolldown.OutputChunk) => boolean;
  /** Options for the server environment, merged over the shared ones. */
  serverEnvironment?: EnvironmentOptions;
}

const modulePath = (file: string): string => file.replaceAll("\\", "/");

/** A module path for generated source, with forward slashes on every platform. */
export const importPath = (file: string): string => JSON.stringify(modulePath(file));

/**
 * The file of the server entry among a bundle's entry chunks, written to
 * `directory`. Throws, naming the integration and `description`, when the
 * bundle has none or the file is missing.
 */
export function findServerEntry(
  integration: Pick<ArtifactIntegration, "name">,
  bundle: Rolldown.OutputBundle,
  directory: string,
  isServerEntry: (chunk: Rolldown.OutputChunk) => boolean = () => true,
  description = "server entry",
): string {
  const entry = Object.values(bundle).find(
    (chunk): chunk is Rolldown.OutputChunk =>
      chunk.type === "chunk" && chunk.isEntry && isServerEntry(chunk),
  );
  const serverModule = entry && join(directory, entry.fileName);
  if (!serverModule || !existsSync(serverModule)) {
    throw new Error(`${integration.name} found no ${description} in ${directory}`);
  }
  return serverModule;
}

/** Where the server module is and what else the artifact takes from the build. */
export interface ServerArtifactSource {
  /** The Vite root; `outDir` resolves from it. */
  root: string;
  /** The built server module. */
  serverModule: string;
  /** The directory the entry's imports resolve from. Defaults to the module's. */
  resolveDir?: string;
  /** A URL prefix of hashed client files, cached for a year. */
  hashedAssets?: string;
}

/** Writes the artifact around a framework's built server module. */
export async function writeServerArtifact(
  integration: ArtifactIntegration,
  { outDir = "build", backend = "portable", intl = {}, assets = false }: ViteArtifactOptions,
  { root, serverModule, resolveDir = dirname(serverModule), hashedAssets }: ServerArtifactSource,
): Promise<void> {
  const defaults = integration.assetDefaults ?? {};
  const cache = [
    ...(defaults.cache ?? []),
    ...(hashedAssets ? [{ prefix: hashedAssets, cacheControl: IMMUTABLE }] : []),
  ];
  await buildArtifact({
    entry: {
      source: integration.entrySource(serverModule),
      resolveDir,
    },
    outDir: resolve(root, outDir),
    framework: integration.framework,
    rendering: integration.rendering,
    ...(integration.asyncContext ? { asyncContext: integration.asyncContext } : {}),
    backend,
    intl,
    ...(assets
      ? { assets: frameworkAssets(assets, cache.length ? { ...defaults, cache } : defaults) }
      : {}),
  });
}

/** The URL prefix of the client build's hashed files: `base` and `build.assetsDir`. */
function hashedAssetPrefix(config: ResolvedConfig): string {
  const build = config.environments?.client?.build ?? config.build;
  const base = config.base.endsWith("/") ? config.base : config.base + "/";
  return base + build.assetsDir.replace(/^\/+|\/+$/g, "") + "/";
}

/** The plugin that builds an integration's server environment into an artifact. */
export function serverEnvironmentPlugin(
  integration: ServerEnvironmentIntegration,
  options: ViteArtifactOptions,
): Plugin {
  const { outDir = "build" } = options;
  const environmentName = integration.environment ?? "ssr";
  const cacheDirectory = "node_modules/.cache/" + integration.name.replaceAll("/", "-");
  let root = process.cwd();
  let hashedAssets = "/assets/";
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
              resolve: {
                noExternal: true,
              },
              build: {
                outDir: cacheDirectory,
              },
            },
            integration.serverEnvironment ?? {},
          ),
        },
      };
    },
    configResolved(config) {
      root = config.root;
      hashedAssets = hashedAssetPrefix(config);
    },
    applyToEnvironment(environment) {
      return environment.name === environmentName;
    },
    configEnvironment(name, config) {
      if (name === environmentName) {
        serverDirectory = config.build?.outDir;
      }
    },
    async writeBundle(output, bundle) {
      const directory = resolve(root, output.dir ?? serverDirectory ?? cacheDirectory);
      const serverModule = findServerEntry(
        integration,
        bundle,
        directory,
        integration.isServerEntry,
      );
      await writeServerArtifact(integration, options, {
        root,
        serverModule,
        resolveDir: directory,
        hashedAssets,
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
    resolve: {
      ...base.resolve,
      ...override.resolve,
    },
    build: {
      ...base.build,
      ...override.build,
    },
  };
}

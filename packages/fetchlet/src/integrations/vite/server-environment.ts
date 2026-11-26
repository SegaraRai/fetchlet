// The Vite plugin shape every fetchlet integration built on Vite environments
// shares: the client build goes to `<outDir>/client`, the server environment
// to a cache directory, and once the server bundle is written, its entry is
// wrapped by the integration's glue and bundled into the artifact.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
   * entries, and a function returns every entry. See https://fetchlet.roundtrip.dev/docs/reference/asset-archive.
   */
  assets?: AssetsOption;
  /** Where server.js, fetchlet.json and client/ are written. Defaults to "build". */
  outDir?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
  /**
   * APIs the application needs beyond the Web API profile, as in
   * fetchlet/build: Intl APIs such as `Intl.DateTimeFormat`, and globals over
   * host Web APIs such as `crypto.subtle`. Recorded in fetchlet.json, where
   * the Rust host checks them before the server runs.
   */
  requirements?: string[];
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
  /**
   * Whether the server build embeds what the client build produced, such as
   * its manifest. Under `vite build --watch`, server builds then follow the
   * client builds, so the artifact names the current client files.
   */
  embedsClientBuild?: boolean;
  /**
   * With `embedsClientBuild`, called under `vite build --watch` as each
   * server build starts, once it follows a written client build, with that
   * build's output. For frameworks that keep the client build in state a
   * server build overwrites.
   */
  serverBuildStarting?(client: ClientBuildOutput): void;
}

/** A client build's output as its `writeBundle` hook saw it. */
export interface ClientBuildOutput {
  bundle: Rolldown.OutputBundle;
  /** The directory the bundle was written to. */
  dir: string | undefined;
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
  {
    outDir = "build",
    backend = "portable",
    intl = {},
    requirements = [],
    assets = false,
  }: ViteArtifactOptions,
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
    requirements,
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

/**
 * Orders an integration's client and server builds under
 * `vite build --watch`, where Vite starts every environment's watcher at
 * once, runs `buildApp` hooks only before the first build, and rebuilds an
 * environment only when its own inputs change.
 *
 * Each client build writes a stamp file after its bundle and the framework's
 * hooks, which record the client build for the server, have run. Every
 * server build watches the stamp, so a client build rebuilds the server
 * with the new client file names. A server build waits for the client build
 * in progress, and the first one for the first client build. A server build
 * that started before a client build did is not written: the server build
 * that client build causes replaces it.
 */
class ClientBuildTracker {
  readonly stampFile: string;
  /** The last client build written. */
  written: ClientBuildOutput | undefined;
  /** Settles when the client build in progress ends; undefined between builds. */
  #building: Deferred | undefined;
  /** Whether a client build has ended, written or failed. */
  #ended = false;
  /** Client builds started so far. */
  #started = 0;

  constructor(stampFile: string) {
    this.stampFile = stampFile;
  }

  clientStarted(): void {
    this.#started++;
    this.#building ??= deferred();
  }

  async clientWritten(output: ClientBuildOutput): Promise<void> {
    this.written = output;
    await mkdir(dirname(this.stampFile), { recursive: true });
    await writeFile(this.stampFile, `${this.#started}\n`);
    this.clientEnded();
  }

  clientEnded(): void {
    this.#ended = true;
    this.#building?.resolve();
    this.#building = undefined;
  }

  /**
   * Waits for the first client build, or for the one in progress, and
   * returns the number of client builds the server build follows.
   */
  async serverStarting(): Promise<number> {
    if (!this.#ended) {
      this.#building ??= deferred();
    }
    await this.#building?.promise;
    return this.#started;
  }

  /** Whether a client build started after the server build that saw `started`. */
  clientStartedSince(started: number): boolean {
    return this.#started !== started;
  }
}

/**
 * The trackers by stamp file. Frameworks that resolve each environment's
 * configuration on its own, such as Solid's, load the Vite configuration
 * again and create a plugin per environment, which share the tracker here.
 */
const trackers = new Map<string, ClientBuildTracker>();

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    resolve,
  };
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
  // For `embedsClientBuild`. The stamp sits with Vite's own client
  // manifest in `.vite/`, which the asset archive leaves out.
  let tracker: ClientBuildTracker | undefined;
  let serverFollows = 0;
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
                rolldownOptions: {
                  // fetchlet/build adds the runtime once, before the
                  // application; a copy bundled here would install the Web
                  // API profile twice.
                  external: [/^fetchlet\/runtime(\/|$)/],
                },
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
      const client = config.environments?.client?.build.outDir;
      if (integration.embedsClientBuild && client) {
        const stampFile = resolve(root, client, ".vite", "fetchlet-client-build");
        tracker = trackers.get(stampFile) ?? new ClientBuildTracker(stampFile);
        trackers.set(stampFile, tracker);
      }
    },
    applyToEnvironment(environment) {
      return (
        environment.name === environmentName ||
        (integration.embedsClientBuild === true && environment.name === "client")
      );
    },
    configEnvironment(name, config) {
      if (name === environmentName) {
        serverDirectory = config.build?.outDir;
      }
    },
    async buildStart() {
      if (!tracker || !this.meta.watchMode) {
        return;
      }
      if (this.environment.name === "client") {
        tracker.clientStarted();
        return;
      }
      serverFollows = await tracker.serverStarting();
      if (tracker.written) {
        integration.serverBuildStarting?.(tracker.written);
      }
      // On the build: rolldown does not rebuild for a file a virtual
      // module's hooks add.
      this.addWatchFile(tracker.stampFile);
    },
    buildEnd(error) {
      // A failed client build releases the server, which builds with what
      // the framework has; the next client build rebuilds it.
      if (error && tracker && this.meta.watchMode && this.environment.name === "client") {
        tracker.clientEnded();
      }
    },
    async writeBundle(output, bundle) {
      if (this.environment?.name === "client") {
        // The framework plugins come first and record the client build in
        // `generateBundle` or at the start of their own `writeBundle`.
        if (tracker && this.meta.watchMode) {
          await tracker.clientWritten({
            bundle,
            dir: output.dir,
          });
        }
        return;
      }
      if (tracker && this.meta?.watchMode && tracker.clientStartedSince(serverFollows)) {
        this.info("a client build started; the server builds again after it");
        return;
      }
      await writeServer(output, bundle);
    },
  };

  async function writeServer(
    output: Rolldown.NormalizedOutputOptions,
    bundle: Rolldown.OutputBundle,
  ): Promise<void> {
    const directory = resolve(root, output.dir ?? serverDirectory ?? cacheDirectory);
    const serverModule = findServerEntry(integration, bundle, directory, integration.isServerEntry);
    await writeServerArtifact(integration, options, {
      root,
      serverModule,
      resolveDir: directory,
      hashedAssets,
    });
  }
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

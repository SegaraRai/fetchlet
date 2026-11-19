// The `assets` option that buildArtifact and the adapters take, and how it
// becomes the entries of an artifact's assets.flpk.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeAssetArchive, type AssetArchiveSummary, type AssetEntry } from "./asset-archive.ts";
import {
  directoryAssets,
  type AssetInclude,
  type AssetRoutes,
  type CacheRule,
  type DirectoryAssetOptions,
} from "./asset-entries.ts";
import { writeManifest } from "./manifest.ts";

/** What an `assets` function receives. */
export interface AssetContext {
  /** The artifact's client directory, such as `build/client`. */
  directory: string;
  /**
   * The entries `true` would archive: `directoryAssets` over `directory`
   * with the framework's defaults, and `options` on top of them.
   */
  defaults: (options?: DirectoryAssetOptions) => Promise<AssetEntry[]>;
}

/** Return every entry of the archive. */
export type AssetEntriesFunction = (
  context: AssetContext,
) => Iterable<AssetEntry> | Promise<Iterable<AssetEntry>>;

/** The framework's defaults with `DirectoryAssetOptions`, then `entries`. */
export interface AssetSettings extends DirectoryAssetOptions {
  /** Entries without a file, after the client directory's. */
  entries?: AssetEntry[];
}

/**
 * Pack the client assets into `assets.flpk` for fetchlet-http to serve or
 * embed. `true` archives the client directory with the framework's
 * defaults; settings adjust those defaults and add entries; a function
 * returns every entry itself. See docs/asset-archive.md.
 */
export type AssetsOption = boolean | AssetSettings | AssetEntriesFunction;

/** What an adapter's framework sets before the app's options. */
export interface FrameworkAssetDefaults {
  /** `Cache-Control` rules; the app's rules win for the same prefix. */
  cache?: CacheRule[];
  /** Routes, unless the app sets its own. */
  routes?: AssetRoutes;
  /** The framework's decision, which the app's `include` receives as `defaults`. */
  include?: AssetInclude;
}

/**
 * An adapter's `assets` option as one function, with its framework's
 * defaults beneath the app's options.
 */
export function frameworkAssets(
  option: Exclude<AssetsOption, false>,
  framework: FrameworkAssetDefaults = {},
): AssetEntriesFunction {
  const defaults =
    (directory: string) =>
    (options: DirectoryAssetOptions = {}): Promise<AssetEntry[]> =>
      directoryAssets(directory, withDefaults(framework, options));
  if (typeof option === "function") {
    return (context) =>
      option({
        directory: context.directory,
        defaults: defaults(context.directory),
      });
  }
  const { entries = [], ...options } = option === true ? {} : option;
  return async (context) => [...(await defaults(context.directory)(options)), ...entries];
}

function withDefaults(
  framework: FrameworkAssetDefaults,
  options: DirectoryAssetOptions,
): DirectoryAssetOptions {
  const routes = options.routes ?? framework.routes;
  return {
    ...(routes ? { routes } : {}),
    // directoryAssets keeps the first of equally long prefixes.
    cache: [...(options.cache ?? []), ...(framework.cache ?? [])],
    include(entry, defaults) {
      const decision = framework.include ? framework.include(entry, defaults) : defaults;
      return options.include ? options.include(entry, decision) : decision;
    },
    ...(options.respond ? { respond: options.respond } : {}),
  };
}

export interface ArchiveArtifactAssetsOptions {
  /** The artifact directory that `buildArtifact` wrote. */
  outDir: string;
  /** Defaults to `true`. */
  assets?: Exclude<AssetsOption, false>;
}

/**
 * Archive an artifact's assets as `assets.flpk` and name it in
 * fetchlet.json, so `Artifact::asset_archive` in fetchlet-http finds it.
 */
export async function archiveArtifactAssets({
  outDir,
  assets = true,
}: ArchiveArtifactAssetsOptions): Promise<AssetArchiveSummary> {
  const manifestPath = join(outDir, "fetchlet.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifestAssets;
  const summary = await archiveAssets(outDir, manifest, assets, manifestPath);
  writeManifest(manifestPath, manifest);
  return summary;
}

/** The fields of fetchlet.json that archiving reads and writes. */
export interface ArtifactManifestAssets {
  client?: string;
  assets?: string;
}

/**
 * Write `assets.flpk` from the client directory `manifest` names and record
 * it in `manifest`, which the caller writes. `source` names the manifest in
 * errors.
 */
export async function archiveAssets(
  outDir: string,
  manifest: ArtifactManifestAssets,
  assets: Exclude<AssetsOption, false>,
  source: string,
): Promise<AssetArchiveSummary> {
  if (!manifest.client) {
    throw new Error(`asset archive: ${source} names no client directory`);
  }
  const directory = join(outDir, manifest.client);
  const entries = await frameworkAssets(assets)({
    directory,
    defaults: (options) => directoryAssets(directory, options),
  });
  const summary = await writeAssetArchive({
    entries,
    out: join(outDir, "assets.flpk"),
  });
  manifest.assets = "assets.flpk";
  return summary;
}

// The release version and the manifests that carry it. One version covers every
// published npm package and crate: pnpm change versions the npm packages and
// the crate placeholders together (`versioning.fixed` in pnpm-workspace.yaml),
// and sync-version.ts copies the result to the Cargo workspace.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cargoEnv } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";

/** The crates published to crates.io, in dependency order. */
export const publishedCrates = [
  "fetchlet-web",
  "fetchlet",
  "fetchlet-http",
  "fetchlet-net",
] as const;

/** The npm package that stands for a crate in pnpm change. */
export function cratePlaceholder(crate: string): string {
  return `@fetchlet-crates/${crate}`;
}

/** Orders names by code unit, the same on every locale. */
export function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The directory of the placeholder whose version names the release. */
const versionSource = "crates/fetchlet";

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
}

export function readPackage(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as PackageManifest;
}

/** The version pnpm change last applied. */
export function releaseVersion(): string {
  return readPackage(versionSource).version;
}

/** The npm packages under packages/, which are released with the crates. */
export function releasedPackageDirectories(): string[] {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((directory) => existsSync(join(root, directory, "package.json")));
}

/** Every package name in the fixed version group. */
export function fixedGroup(): string[] {
  return [
    ...releasedPackageDirectories().map((directory) => readPackage(directory).name),
    ...publishedCrates.map(cratePlaceholder),
  ].sort(byName);
}

/**
 * Sets the workspace package version and the exact requirements the published
 * crates have on each other.
 */
export function withCargoVersion(manifest: string, version: string): string {
  const crates = publishedCrates.join("|");
  return manifest
    .replace(/^(\[workspace\.package\][^[]*?^version = ")[^"]+/m, (_, prefix: string) => {
      return prefix + version;
    })
    .replace(
      new RegExp(`^((?:${crates}) = \\{[^}\\n]*\\bversion = "=)[^"]+`, "gm"),
      (_, prefix: string) => prefix + version,
    );
}

export interface CargoPackage {
  name: string;
  version: string;
  publish: string[] | null;
  license: string | null;
  repository: string | null;
  description: string | null;
  manifest_path: string;
  dependencies: { name: string; req: string; path?: string; kind: string | null }[];
}

/** The workspace members, as `cargo metadata` reports them. */
export function cargoPackages(): CargoPackage[] {
  const result = spawnSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version", "1"],
    { cwd: root, env: cargoEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${result.stderr}`);
  }
  return (JSON.parse(result.stdout) as { packages: CargoPackage[] }).packages;
}

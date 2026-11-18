import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { root } from "./paths.ts";
import { run } from "./process.ts";

/**
 * What a result was produced with. Results record versions rather than
 * timestamps: the versions decide what a result means, and a rerun with the
 * same versions leaves the file unchanged.
 */
export interface Environment {
  node: string;
  rustc: string;
  platform: string;
  /** Engine crate versions from Cargo.lock. */
  engines: { quickjs: string; boa: string; v8: string };
  /** Installed versions of the named packages, when requested. */
  packages?: Record<string, string>;
}

let rustc: string | undefined;

/**
 * The toolchain and engine versions of this checkout. `packagesOf` names a
 * directory whose package.json dependencies are reported with their
 * installed versions.
 */
export function environment(options: { packagesOf?: string } = {}): Environment {
  rustc ??= execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
  const result: Environment = {
    node: process.version,
    rustc,
    platform: `${process.platform}-${process.arch}`,
    engines: {
      quickjs: "rquickjs " + crateVersion("rquickjs"),
      boa: "boa_engine " + crateVersion("boa_engine"),
      v8: "v8 " + crateVersion("v8"),
    },
  };
  if (options.packagesOf) {
    result.packages = installedPackages(options.packagesOf);
  }
  return result;
}

function crateVersion(name: string): string {
  const lock = readFileSync(resolve(root, "Cargo.lock"), "utf8");
  const match = new RegExp(
    `\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = "([^"]+)"`,
  ).exec(lock);
  if (!match?.[1]) {
    throw new Error(`${name} is not in Cargo.lock`);
  }
  return match[1];
}

/** The installed version of each dependency in a directory's package.json. */
export function installedPackages(directory: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).sort();
  const versions: Record<string, string> = {};
  for (const name of names) {
    const file = join(directory, "node_modules", name, "package.json");
    if (existsSync(file)) {
      versions[name] = JSON.parse(readFileSync(file, "utf8")).version;
    }
  }
  return versions;
}

/**
 * Writes `value` as JSON in the layout `vp fmt` gives it, so `check:format`
 * accepts the file and a rerun with the same outcomes leaves it unchanged.
 */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  if (run("vp", ["fmt", file], { log: logPath("format.log") }) !== 0) {
    throw new Error(`vp fmt could not format ${file}; see results/logs/format.log`);
  }
}

/** Writes a JSON result under `results/`, which the documentation reports from. */
export function writeResult(name: string, value: unknown): void {
  writeJson(resolve(root, "results", name), value);
}

/** Writes a text file under `results/`. */
export function writeText(name: string, text: string): void {
  const file = resolve(root, "results", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A log under `results/logs/`, which is not tracked. */
export function logPath(name: string): string {
  return resolve(root, "results/logs", name);
}

/** The text of an error with its stack, for result files. */
export function describe(error: unknown): string {
  return String((error as Error)?.stack ?? error);
}

export interface PassFail {
  status: string;
}

export function summarize(rows: readonly PassFail[]) {
  return {
    passed: rows.filter((row) => row.status === "pass").length,
    failed: rows.filter((row) => row.status === "fail").length,
  };
}

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { delimiter, dirname } from "node:path";

import { root } from "./paths.ts";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Writes stdout and stderr to this file instead of the terminal. */
  log?: string;
}

/**
 * Runs a command to completion with inherited output and returns its exit code.
 * The command is resolved through PATH, including `.cmd` shims on Windows.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): number {
  const log = options.log === undefined ? undefined : openLog(options.log);
  try {
    const spawnOptions: SpawnSyncOptions = {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: log === undefined ? "inherit" : ["ignore", log, log],
      windowsHide: true,
      shell: needsShell(command),
    };
    const result = spawnSync(command, needsShell(command) ? args.map(quote) : args, spawnOptions);
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  } finally {
    if (log !== undefined) {
      closeSync(log);
    }
  }
}

/** Runs each command in order and exits the process with the first failure's code. */
export function runAll(
  commands: ReadonlyArray<readonly [string, readonly string[]]>,
  options: RunOptions = {},
): void {
  for (const [command, args] of commands) {
    const code = run(command, args, options);
    if (code !== 0) {
      process.exit(code);
    }
  }
}

/**
 * An environment with directories prepended to PATH. Windows spells the
 * variable `Path`, and a copy of `process.env` must keep a single spelling.
 */
export function prependPath(
  directories: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const key = Object.keys(base).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...base, [key]: [...directories, base[key] ?? ""].join(delimiter) };
}

function openLog(file: string): number {
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, "w");
}

// Package manager binaries are `.cmd` shims on Windows, which only a shell can start.
function needsShell(command: string): boolean {
  return process.platform === "win32" && ["vp", "pnpm", "npx"].includes(command);
}

function quote(argument: string): string {
  return /[\s"&|<>^]/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}

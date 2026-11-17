// Runs Cargo with the C compiler this workspace builds native dependencies with.
//
//   node tools/workspace/cargo.ts <cargo arguments>
import { existsSync } from "node:fs";

import { run, type RunOptions } from "./process.ts";

const clangCl = "C:\\Program Files\\LLVM\\bin\\clang-cl.exe";

/**
 * The environment for Cargo. On Windows, native dependencies such as QuickJS
 * build with clang-cl when LLVM is installed, matching the MSVC flags the
 * local toolchain configuration uses.
 */
export function cargoEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== "win32" || !existsSync(clangCl)) return base;
  return { ...base, CC: clangCl, CXX: clangCl };
}

/** Runs Cargo and returns its exit code. */
export function cargo(args: readonly string[], options: RunOptions = {}): number {
  return run("cargo", args, { ...options, env: cargoEnv(options.env) });
}

/** Runs each Cargo invocation in order and exits with the first failure's code. */
export function cargoAll(invocations: ReadonlyArray<readonly string[]>): void {
  for (const args of invocations) {
    const code = cargo(args);
    if (code !== 0) process.exit(code);
  }
}

if (import.meta.main) {
  process.exit(cargo(process.argv.slice(2)));
}

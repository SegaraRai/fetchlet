// Runs Cargo with the C compiler this workspace builds native dependencies with.
//
//   node tools/workspace/cargo.ts <cargo arguments>

import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { root } from "./paths.ts";
import { run, type RunOptions } from "./process.ts";

const clangCl = "C:\\Program Files\\LLVM\\bin\\clang-cl.exe";

/**
 * The environment for Cargo. On Windows, native dependencies such as QuickJS
 * build with clang-cl when LLVM is installed, matching the MSVC flags the
 * local toolchain configuration uses. `VSLANG=1033` keeps MSVC diagnostics in
 * English, so recorded results read the same on every system locale.
 */
export function cargoEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return base;
  }
  const env = { ...base, VSLANG: base.VSLANG ?? "1033" };
  return existsSync(clangCl) ? { ...env, CC: clangCl, CXX: clangCl } : env;
}

/**
 * The size `target/` may reach before Cargo runs again from a clean state.
 * Cargo keeps the artifacts of every feature, profile and dependency
 * combination it has built and never removes them, so the directory only
 * grows. The budget is caller policy: `FETCHLET_TARGET_BUDGET_GIB` sets it,
 * and 0 turns the check off.
 */
const defaultTargetBudgetGib = 64;

/** How often to measure `target/`; measuring reads every file's size. */
const targetCheckInterval = 60 * 60 * 1000;

/**
 * Total bytes of the files under `directory`. Builds running at the same
 * time create and remove files, so entries that are gone by the time they
 * are read count as empty.
 */
function directoryBytes(directory: string): number {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += directoryBytes(path);
    } else if (entry.isFile()) {
      bytes += lstatSync(path, { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  return bytes;
}

/**
 * Clean `target/` when it exceeds the budget. Runs at most once an hour,
 * recorded by the modification time of a stamp file in `target/`.
 */
export function enforceTargetBudget(env: NodeJS.ProcessEnv = process.env): void {
  const budgetGib = Number(env.FETCHLET_TARGET_BUDGET_GIB ?? defaultTargetBudgetGib);
  if (!Number.isFinite(budgetGib) || budgetGib <= 0) {
    return;
  }
  const target = resolve(root, "target");
  const stamp = join(target, ".fetchlet-budget-check");
  if (!existsSync(target)) {
    return;
  }
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < targetCheckInterval) {
    return;
  }
  const gib = directoryBytes(target) / 2 ** 30;
  if (gib > budgetGib) {
    console.log(
      `target/ holds ${gib.toFixed(1)} GiB, over the ${budgetGib} GiB budget; running cargo clean`,
    );
    // Clean the directory measured, not a target directory the caller set
    // inside it, which would leave the rest over the budget.
    const { CARGO_TARGET_DIR: _, CARGO_BUILD_TARGET_DIR: __, ...cleanEnv } = env;
    run("cargo", ["clean"], { cwd: root, env: cargoEnv(cleanEnv) });
    mkdirSync(target, { recursive: true });
  }
  writeFileSync(stamp, "");
}

/** Runs Cargo and returns its exit code. */
export function cargo(args: readonly string[], options: RunOptions = {}): number {
  enforceTargetBudget(options.env);
  return run("cargo", args, { ...options, env: cargoEnv(options.env) });
}

/** Runs each Cargo invocation in order and exits with the first failure's code. */
export function cargoAll(invocations: ReadonlyArray<readonly string[]>): void {
  for (const args of invocations) {
    const code = cargo(args);
    if (code !== 0) {
      process.exit(code);
    }
  }
}

if (import.meta.main) {
  process.exit(cargo(process.argv.slice(2)));
}

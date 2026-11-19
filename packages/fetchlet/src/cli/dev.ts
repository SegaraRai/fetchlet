// `fetchlet dev`: builds the artifact, starts the server that serves it, and
// builds again whenever a watched source changes. The server reloads each
// build itself, as fetchlet-http's `DevReload` does, so it keeps running
// across builds.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface DevOptions {
  /** Files or directories whose changes start a build, relative to `cwd`. */
  watch: string[];
  /** The shell command that builds the artifact. */
  build: string;
  /** The program that serves each build, and its arguments. */
  server: string[];
  /** The directory the paths and commands are relative to. */
  cwd: string;
}

export const DEV_USAGE = `usage: fetchlet dev [--watch <path>]... [--build <command>] -- <server> [<argument>...]

Builds with <command>, starts <server>, and builds again when a file under a
watched path changes. The server keeps running and serves each new build.

  --watch <path>     A file or directory to watch; repeatable. Default: src
  --build <command>  The shell command that builds. Default: vite build`;

/** The options a `fetchlet dev` command line gives, or the reason it is invalid. */
export function parseDevArguments(
  args: readonly string[],
  cwd: string,
): DevOptions | { error: string } {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  const server = separator === -1 ? [] : args.slice(separator + 1);
  const watched: string[] = [];
  let build = "vite build";
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const value = options[index + 1];
    if ((option === "--watch" || option === "--build") && value === undefined) {
      return {
        error: `${option} needs a value`,
      };
    }
    if (option === "--watch") {
      watched.push(value);
      index++;
    } else if (option === "--build") {
      build = value;
      index++;
    } else {
      return {
        error: `unknown option ${option}`,
      };
    }
  }
  if (server.length === 0) {
    return {
      error: "name the server command after --",
    };
  }
  return {
    watch: watched.length > 0 ? watched : ["src"],
    build,
    server,
    cwd,
  };
}

/**
 * The content of the watched files as last seen. A file counts as changed
 * when its content differs, so files a build rewrites unchanged, such as
 * generated route tables, do not start another build.
 */
export class WatchedFiles {
  private readonly roots: string[];
  private readonly seen = new Map<string, string | undefined>();

  constructor(paths: readonly string[], cwd: string) {
    this.roots = paths.map((path) => resolve(cwd, path));
    this.snapshot();
  }

  /** Whether `file` is one of the watched paths or under one. */
  includes(file: string): boolean {
    return this.roots.some((root) => file === root || file.startsWith(root + sep));
  }

  /** Record the current content of every watched file. */
  snapshot(): void {
    this.seen.clear();
    for (const file of this.roots.flatMap(filesUnder)) {
      this.seen.set(file, contentHash(file));
    }
  }

  /**
   * Whether `file` changed since it was last seen, recording its content. A
   * directory, or a file that came and went, is no change.
   */
  changed(file: string): boolean {
    if (!this.includes(file)) {
      return false;
    }
    const hash = contentHash(file);
    if (hash === undefined && !this.seen.has(file)) {
      return false;
    }
    if (this.seen.get(file) === hash) {
      return false;
    }
    this.seen.set(file, hash);
    return true;
  }
}

/** The files under `path`, or `path` itself when it is a file. */
function filesUnder(path: string): string[] {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return [];
  }
  if (stats.isFile()) {
    return [path];
  }
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The content hash of `file`, or undefined when it is missing or not a file. */
function contentHash(file: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

/** How long to wait after a change for more changes before building. */
const SETTLE_MS = 100;

const windows = process.platform === "win32";

/** An argument as one word of a Windows command line. */
function quote(argument: string): string {
  return /[\s"&|<>^]/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}

/** Stop `child` and the processes it started. */
function kill(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (windows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

function runBuild(options: DevOptions): ChildProcess {
  return spawn(options.build, { cwd: options.cwd, stdio: "inherit", shell: true });
}

/**
 * Run the development loop until the server exits or the process is
 * interrupted. Resolves to the exit code: the first build's when it fails,
 * otherwise the server's.
 */
export function dev(options: DevOptions): Promise<number> {
  return new Promise((resolveExit) => {
    console.log("[fetchlet dev] building");
    const first = runBuild(options);
    first.on("error", (error) => {
      console.error(`[fetchlet dev] ${error.message}`);
      resolveExit(1);
    });
    first.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[fetchlet dev] the build failed with exit code ${code}`);
        resolveExit(code ?? 1);
        return;
      }
      serve(options, resolveExit);
    });
  });
}

function serve(options: DevOptions, resolveExit: (code: number) => void): void {
  const files = new WatchedFiles(options.watch, options.cwd);
  let building = false;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  let builder: ChildProcess | undefined;

  function build(): void {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    pending = false;
    console.log("[fetchlet dev] building");
    const started = Date.now();
    builder = runBuild(options);
    builder.on("exit", (code) => {
      building = false;
      builder = undefined;
      console.log(
        code === 0
          ? `[fetchlet dev] built in ${Date.now() - started} ms`
          : `[fetchlet dev] the build failed with exit code ${code}; the server keeps the previous build`,
      );
      // What the build itself rewrote is not a change to build again for;
      // edits made while it ran have already set `pending`.
      files.snapshot();
      if (pending) {
        build();
      }
    });
  }

  const watcher = watch(
    options.cwd,
    {
      recursive: true,
    },
    (_event, name) => {
      if (name && files.changed(resolve(options.cwd, name))) {
        clearTimeout(timer);
        timer = setTimeout(build, SETTLE_MS);
      }
    },
  );

  const [program, ...args] = options.server;
  // A Windows shell starts `.cmd` shims such as npm's, which spawn cannot.
  const server = windows
    ? spawn([program, ...args].map(quote).join(" "), {
        cwd: options.cwd,
        stdio: "inherit",
        shell: true,
      })
    : spawn(program, args, {
        cwd: options.cwd,
        stdio: "inherit",
      });

  let exiting = false;
  function stop(code: number): void {
    if (exiting) {
      return;
    }
    exiting = true;
    watcher.close();
    clearTimeout(timer);
    kill(builder);
    kill(server);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    resolveExit(code);
  }
  const interrupt = () => stop(130);
  const terminate = () => stop(143);

  server.on("exit", (code) => stop(code ?? 1));
  server.on("error", (error) => {
    console.error(`[fetchlet dev] ${error.message}`);
    stop(1);
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
}

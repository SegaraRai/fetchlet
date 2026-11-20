// `fetchlet dev`: builds the artifact, starts the server that serves it, and
// builds again whenever a watched source changes, or keeps a watching build
// running. The server reloads each build itself, as fetchlet-http's
// `DevReload` does, so it keeps running across builds. With `--vite`, it
// starts a Vite dev server instead, and the server runs the server module
// from it, as fetchlet-http's `ViteDev` does.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

/** How the artifact is built while the server runs. */
export type DevBuild =
  | {
      /** A full build after each change of a watched file. */
      mode: "rebuild";
      /** The shell command that builds the artifact once. */
      command: string;
      /**
       * Files or directories whose changes start a build, relative to `cwd`.
       * Empty for the defaults of `defaultWatchPaths`.
       */
      watch: string[];
    }
  | {
      /** One build command that keeps running and rebuilds by itself. */
      mode: "watch";
      /** The shell command, such as `vite build --watch`. */
      command: string;
      /** The artifact directory, whose manifest the first build writes. */
      out: string;
    }
  | {
      /** No build: a Vite dev server that the server runs the module from. */
      mode: "vite";
      /**
       * The shell command that starts it, such as `vite dev`, without a host
       * or port, which are appended.
       */
      command: string;
      /** The port, or undefined for a free one. */
      port: number | undefined;
    };

export interface DevOptions {
  build: DevBuild;
  /** The program that serves each build, and its arguments. */
  server: string[];
  /** The directory the paths and commands are relative to. */
  cwd: string;
}

export const DEV_USAGE = `usage: fetchlet dev [--watch <path>]... [--build <command>] -- <server> [<argument>...]
       fetchlet dev --build-watch <command> [--out <directory>] -- <server> [<argument>...]
       fetchlet dev --vite <command> [--vite-port <port>] -- <server> [<argument>...]

Builds with <command>, starts <server>, and builds again when a file under a
watched path changes. With --build-watch, the command keeps running and
rebuilds by itself, and <server> starts once it wrote the first build. The
server keeps running and serves each new build. With --vite, no build runs:
the command starts a Vite dev server, and <server> starts once it answers,
with FETCHLET_VITE_URL set to its URL.

  --watch <path>           A file or directory to watch; repeatable. Default:
                           src, app, web and public, and the framework and
                           Vite configuration files, where they exist
  --build <command>        The shell command that builds. Default: vite build
  --build-watch <command>  A shell command that rebuilds on changes by itself,
                           such as vite build --watch
  --out <directory>        The artifact directory of --build-watch. Default: build
  --vite <command>         A shell command that starts a Vite dev server, such
                           as vite dev or astro dev; --host and --port are appended
  --vite-port <port>       The dev server's port. Default: a free port`;

const VALUED = new Set(["--watch", "--build", "--build-watch", "--out", "--vite", "--vite-port"]);

/** The options a `fetchlet dev` command line gives, or the reason it is invalid. */
export function parseDevArguments(
  args: readonly string[],
  cwd: string,
): DevOptions | { error: string } {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  const server = separator === -1 ? [] : args.slice(separator + 1);
  const watched: string[] = [];
  let build: string | undefined;
  let buildWatch: string | undefined;
  let out: string | undefined;
  let vite: string | undefined;
  let vitePort: string | undefined;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const value = options[index + 1];
    if (!VALUED.has(option)) {
      return { error: `unknown option ${option}` };
    }
    if (value === undefined) {
      return { error: `${option} needs a value` };
    }
    index++;
    if (option === "--watch") {
      watched.push(value);
    } else if (option === "--build") {
      build = value;
    } else if (option === "--build-watch") {
      buildWatch = value;
    } else if (option === "--out") {
      out = value;
    } else if (option === "--vite") {
      vite = value;
    } else {
      vitePort = value;
    }
  }
  if (server.length === 0) {
    return { error: "name the server command after --" };
  }
  if (vite !== undefined) {
    if (
      build !== undefined ||
      watched.length > 0 ||
      buildWatch !== undefined ||
      out !== undefined
    ) {
      return {
        error: "--vite runs without a build; leave out --build, --watch, --build-watch and --out",
      };
    }
    if (vitePort !== undefined && !/^[1-9]\d{0,4}$/.test(vitePort)) {
      return { error: "--vite-port needs a port number" };
    }
    return {
      build: {
        mode: "vite",
        command: vite,
        port: vitePort === undefined ? undefined : Number(vitePort),
      },
      server,
      cwd,
    };
  }
  if (vitePort !== undefined) {
    return { error: "--vite-port belongs to --vite" };
  }
  if (buildWatch !== undefined) {
    if (build !== undefined || watched.length > 0) {
      return {
        error: "--build-watch rebuilds by itself; leave out --build and --watch",
      };
    }
    return {
      build: {
        mode: "watch",
        command: buildWatch,
        out: out ?? "build",
      },
      server,
      cwd,
    };
  }
  if (out !== undefined) {
    return {
      error: "--out belongs to --build-watch",
    };
  }
  return {
    build: {
      mode: "rebuild",
      command: build ?? "vite build",
      watch: watched,
    },
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

  /**
   * Whether `file` is one of the watched paths or under one. Rust sources
   * belong to the host, which a build does not change, so they never count.
   */
  includes(file: string): boolean {
    return (
      extname(file) !== ".rs" &&
      this.roots.some((root) => file === root || file.startsWith(root + sep))
    );
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

/** Source directories a framework or Vite project keeps its build inputs in. */
const SOURCE_DIRECTORIES = ["src", "app", "web", "public"];

/** Configuration files whose changes change the build. */
const CONFIGURATION =
  /^(?:vite|astro|nuxt|react-router|svelte|waku|vinext|tsr|app)\.config\.[cm]?[jt]s$/;

/**
 * The paths `fetchlet dev` watches without `--watch`: those of
 * `SOURCE_DIRECTORIES` that exist in `cwd`, and its configuration files.
 */
export function defaultWatchPaths(cwd: string): string[] {
  const directories = SOURCE_DIRECTORIES.filter((name) => existsSync(join(cwd, name)));
  const configuration = readdirSync(cwd).filter((name) => CONFIGURATION.test(name));
  return [...directories, ...configuration.sort()];
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

/** How often a watching build's manifest is checked for its first build. */
const MANIFEST_POLL_MS = 200;

/** How long a Vite dev server may take to answer before `fetchlet dev` gives up. */
const VITE_START_MS = 60_000;

/** A port no listener uses now. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

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

function runShell(command: string, cwd: string): ChildProcess {
  return spawn(command, {
    cwd,
    stdio: "inherit",
    shell: true,
  });
}

/** Whether `file` exists and was modified at or after `time`, in milliseconds. */
export function modifiedSince(file: string, time: number): boolean {
  try {
    // File systems with coarse timestamps round them down by up to two seconds.
    return statSync(file).mtimeMs >= time - 2000;
  } catch {
    return false;
  }
}

/**
 * Run the development loop until the server exits or the process is
 * interrupted. Resolves to the exit code: the first build's when it fails,
 * the watching build's when it stops, otherwise the server's.
 */
export function dev(options: DevOptions): Promise<number> {
  return new Promise((resolveExit) => {
    const session = new Session(options, resolveExit);
    if (options.build.mode === "watch") {
      session.watchBuilds(options.build.command, options.build.out);
    } else if (options.build.mode === "vite") {
      void session.serveVite(options.build.command, options.build.port);
    } else {
      const { watch: paths } = options.build;
      session.rebuild(
        options.build.command,
        paths.length > 0 ? paths : defaultWatchPaths(options.cwd),
      );
    }
  });
}

/** The processes of one `fetchlet dev` run, which stop together. */
class Session {
  private readonly options: DevOptions;
  private readonly resolveExit: (code: number) => void;
  private server: ChildProcess | undefined;
  private builder: ChildProcess | undefined;
  private readonly cleanups: (() => void)[] = [];
  private exiting = false;
  private readonly interrupt = () => this.stop(130);
  private readonly terminate = () => this.stop(143);

  constructor(options: DevOptions, resolveExit: (code: number) => void) {
    this.options = options;
    this.resolveExit = resolveExit;
    process.on("SIGINT", this.interrupt);
    process.on("SIGTERM", this.terminate);
  }

  /** A full build now, then the server, then a full build per change. */
  rebuild(command: string, paths: readonly string[]): void {
    console.log("[fetchlet dev] building");
    const first = runShell(command, this.options.cwd);
    this.builder = first;
    first.on("error", (error) => {
      console.error(`[fetchlet dev] ${error.message}`);
      this.stop(1);
    });
    first.on("exit", (code) => {
      this.builder = undefined;
      if (code !== 0) {
        console.error(`[fetchlet dev] the build failed with exit code ${code}`);
        this.stop(code ?? 1);
        return;
      }
      this.watchSources(command, paths);
      this.startServer();
    });
  }

  private watchSources(command: string, paths: readonly string[]): void {
    const cwd = this.options.cwd;
    const files = new WatchedFiles(paths, cwd);
    let building = false;
    let pending = false;
    let timer: NodeJS.Timeout | undefined;

    const build = (): void => {
      if (building) {
        pending = true;
        return;
      }
      building = true;
      pending = false;
      console.log("[fetchlet dev] building");
      const started = Date.now();
      const builder = runShell(command, cwd);
      this.builder = builder;
      builder.on("exit", (code) => {
        building = false;
        this.builder = undefined;
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
    };

    const watcher = watch(cwd, { recursive: true }, (_event, name) => {
      if (name && files.changed(resolve(cwd, name))) {
        clearTimeout(timer);
        timer = setTimeout(build, SETTLE_MS);
      }
    });
    this.cleanups.push(() => {
      watcher.close();
      clearTimeout(timer);
    });
  }

  /**
   * A build command that keeps running, and the server once the command
   * wrote its first build: a manifest no older than the command.
   */
  watchBuilds(command: string, out: string): void {
    const manifest = resolve(this.options.cwd, out, "fetchlet.json");
    const started = Date.now();
    console.log("[fetchlet dev] starting the watching build");
    const builder = runShell(command, this.options.cwd);
    this.builder = builder;
    builder.on("error", (error) => {
      console.error(`[fetchlet dev] ${error.message}`);
      this.stop(1);
    });
    builder.on("exit", (code) => {
      console.error(`[fetchlet dev] the watching build stopped with exit code ${code}`);
      this.stop(code === 0 || code === null ? 1 : code);
    });
    const poll = setInterval(() => {
      if (modifiedSince(manifest, started)) {
        clearInterval(poll);
        this.startServer();
      }
    }, MANIFEST_POLL_MS);
    this.cleanups.push(() => clearInterval(poll));
  }

  /**
   * A Vite dev server on `port`, or a free one, and the server once Vite
   * answers, with FETCHLET_VITE_URL naming it.
   */
  async serveVite(command: string, port: number | undefined): Promise<void> {
    const vitePort = port ?? (await freePort());
    const url = `http://127.0.0.1:${vitePort}`;
    console.log(`[fetchlet dev] starting the Vite dev server at ${url}`);
    // The port is a number, so the command line needs no quoting.
    const vite = runShell(`${command} --host 127.0.0.1 --port ${vitePort}`, this.options.cwd);
    this.builder = vite;
    vite.on("error", (error) => {
      console.error(`[fetchlet dev] ${error.message}`);
      this.stop(1);
    });
    vite.on("exit", (code) => {
      console.error(`[fetchlet dev] the Vite dev server stopped with exit code ${code}`);
      this.stop(code === 0 || code === null ? 1 : code);
    });
    const deadline = Date.now() + VITE_START_MS;
    while (!this.exiting) {
      try {
        await fetch(`${url}/@vite/client`, { method: "HEAD" });
        this.startServer({ FETCHLET_VITE_URL: url });
        return;
      } catch {
        if (Date.now() > deadline) {
          console.error(`[fetchlet dev] the Vite dev server did not answer at ${url}`);
          this.stop(1);
          return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_POLL_MS));
      }
    }
  }

  private startServer(environment: NodeJS.ProcessEnv = {}): void {
    if (this.exiting) {
      return;
    }
    const [program, ...args] = this.options.server;
    const cwd = this.options.cwd;
    const env = { ...process.env, ...environment };
    // A Windows shell starts `.cmd` shims such as npm's, which spawn cannot.
    const server = windows
      ? spawn([program, ...args].map(quote).join(" "), { cwd, env, stdio: "inherit", shell: true })
      : spawn(program, args, { cwd, env, stdio: "inherit" });
    this.server = server;
    server.on("exit", (code) => this.stop(code ?? 1));
    server.on("error", (error) => {
      console.error(`[fetchlet dev] ${error.message}`);
      this.stop(1);
    });
  }

  private stop(code: number): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    this.cleanups.forEach((cleanup) => cleanup());
    kill(this.builder);
    kill(this.server);
    process.off("SIGINT", this.interrupt);
    process.off("SIGTERM", this.terminate);
    this.resolveExit(code);
  }
}

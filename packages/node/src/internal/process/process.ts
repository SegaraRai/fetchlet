// node:process and the `process` global: an EventEmitter with the
// properties libraries read, for an instance that has no operating-system
// process of its own. The working directory is "/", the environment holds
// NODE_ENV only, and `versions` names no Node release, so code that checks
// for Node takes its Web path.

import { unavailable, validateFunction } from "../errors/errors.ts";
import { EventEmitter } from "../events/event-emitter.ts";
import { setWarningSink } from "./warnings.ts";

const runtime = globalThis as unknown as {
  performance: {
    now(): number;
    timeOrigin: number;
  };
  console?: {
    log(...data: unknown[]): void;
    error(...data: unknown[]): void;
  };
};

interface Output {
  isTTY: false;
  fd: number;
  write(chunk: unknown, encoding?: unknown, callback?: () => void): boolean;
}

function output(fd: number, write: (text: string) => void): Output {
  return {
    isTTY: false,
    fd,
    write(chunk, encoding, callback) {
      const text =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
      write(text.endsWith("\n") ? text.slice(0, -1) : text);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") {
        queueMicrotask(done as () => void);
      }
      return true;
    },
  };
}

function nextTick(callback: (...args: any[]) => unknown, ...args: unknown[]) {
  validateFunction(callback, "callback");
  queueMicrotask(() => callback(...args));
}

function now(): number {
  return runtime.performance.timeOrigin + runtime.performance.now();
}

function hrtime(previous?: [number, number]): [number, number] {
  const nanoseconds = hrtimeBigint();
  const seconds = Number(nanoseconds / 1_000_000_000n);
  const remainder = Number(nanoseconds % 1_000_000_000n);
  if (!previous) {
    return [seconds, remainder];
  }
  let deltaSeconds = seconds - previous[0];
  let deltaNanoseconds = remainder - previous[1];
  if (deltaNanoseconds < 0) {
    deltaSeconds -= 1;
    deltaNanoseconds += 1_000_000_000;
  }
  return [deltaSeconds, deltaNanoseconds];
}

function hrtimeBigint(): bigint {
  return BigInt(Math.round(now() * 1_000_000));
}

hrtime.bigint = hrtimeBigint;

const startedAt = runtime.performance.now();

interface Warning extends Error {
  code?: string;
  detail?: string;
}

class ProcessImpl extends EventEmitter {
  readonly title = "fetchlet";
  readonly version = "";
  readonly versions: Record<string, string> = {};
  readonly release = { name: "fetchlet" };
  readonly platform = "linux";
  readonly arch = "x64";
  readonly argv: string[] = ["fetchlet"];
  readonly argv0 = "fetchlet";
  readonly execArgv: string[] = [];
  readonly execPath = "/fetchlet";
  readonly pid = 1;
  readonly ppid = 0;
  readonly features: Record<string, boolean> = {};
  readonly config = {
    variables: {},
  };
  env: Record<string, string | undefined> = {
    NODE_ENV: "production",
  };
  exitCode: number | undefined = undefined;
  readonly stdout = output(1, (text) => runtime.console?.log(text));
  readonly stderr = output(2, (text) => runtime.console?.error(text));
  readonly nextTick = nextTick;
  readonly hrtime = hrtime;

  cwd(): string {
    return "/";
  }

  chdir(): never {
    throw unavailable("process.chdir");
  }

  umask(): number {
    return 0o22;
  }

  uptime(): number {
    return (runtime.performance.now() - startedAt) / 1000;
  }

  memoryUsage() {
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  }

  cpuUsage() {
    return { user: 0, system: 0 };
  }

  /** Reports a warning to `warning` listeners, or to the console without any. */
  emitWarning(
    warning: string | Warning,
    type?:
      | string
      | {
          type?: string;
          code?: string;
          detail?: string;
        },
    code?: string,
  ) {
    let error: Warning;
    if (typeof warning === "string") {
      const options = typeof type === "object" ? type : { type, code };
      error = new Error(warning) as Warning;
      error.name = options.type ?? "Warning";
      if (options.code !== undefined) {
        error.code = options.code;
      }
      if (typeof type === "object" && type.detail !== undefined) {
        error.detail = type.detail;
      }
    } else {
      error = warning;
    }
    queueMicrotask(() => {
      if (!this.emit("warning", error)) {
        runtime.console?.error(`(fetchlet) ${error.name}: ${error.message}`);
      }
    });
  }

  exit(code?: number): never {
    throw unavailable(`process.exit(${code ?? ""})`);
  }

  abort(): never {
    throw unavailable("process.abort");
  }

  kill(): never {
    throw unavailable("process.kill");
  }

  binding(name: string): never {
    throw unavailable(`process.binding(${JSON.stringify(name)})`);
  }
}

export const process = new ProcessImpl();
setWarningSink((warning, type, code) => process.emitWarning(warning, type, code));

export const {
  title,
  version,
  versions,
  release,
  platform,
  arch,
  argv,
  argv0,
  execArgv,
  execPath,
  pid,
  ppid,
  features,
  config,
  env,
  stdout,
  stderr,
} = process;
export { hrtime, nextTick };
export const cwd = () => process.cwd();
export const uptime = () => process.uptime();
export const memoryUsage = () => process.memoryUsage();
export const cpuUsage = () => process.cpuUsage();
export const emitWarning: ProcessImpl["emitWarning"] = (...args) => process.emitWarning(...args);
export const exit = (code?: number) => process.exit(code);

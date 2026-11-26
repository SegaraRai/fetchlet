// `fetchlet build`: builds a server module in the Workers module shape into
// an artifact without Vite, as `fetchlet/vite` does with it, through
// `buildArtifact` and `exportedHandler` of fetchlet/build. A static
// directory can become the artifact's client assets.

import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildArtifact,
  exportedHandler,
  type AsyncContextMode,
  type BuildBackend,
} from "../build/index.ts";

export interface BuildCommandOptions {
  /** The server module, relative to `cwd`. */
  entry: string;
  /** The artifact directory, relative to `cwd`. */
  out: string;
  backend: BuildBackend;
  requirements: string[];
  /** Locales whose Intl data is bundled; empty for fetchlet/build's default. */
  locales: string[];
  timeZoneData: "utc" | "golden" | "all" | undefined;
  asyncContext: AsyncContextMode | undefined;
  conditions: string[];
  define: Record<string, string>;
  /** A directory copied to `<out>/client`, relative to `cwd`. */
  publicDir: string | undefined;
  /** Pack `<out>/client` into `assets.flpk`. */
  assets: boolean;
  /** The directory the paths are relative to. */
  cwd: string;
}

export const BUILD_USAGE = `
usage: fetchlet build [<entry>] [--out <directory>] [--backend <backend>]
                      [--public <directory>] [--assets] [<option>...]

Builds <entry>, a server module in the Workers module shape, into an
artifact: server.js and fetchlet.json in the output directory. A module
without a default export builds an artifact of functions only.

  <entry>                  The server module. Default: src/server.ts
  --out <directory>        The artifact directory. Default: build
  --backend <backend>      quickjs, boa, v8 or portable. Default: portable
  --public <directory>     Static files, copied to <out>/client
  --assets                 Pack <out>/client into assets.flpk
  --require <api>          An API beyond the Web API profile; repeatable
  --locale <tag>           A locale whose Intl data is bundled; repeatable.
                           Default: en
  --time-zones <data>      Time zone data: utc, golden or all. Default: utc
  --async-context <mode>   Provide node:async_hooks: serialized or propagated
  --condition <name>       An export condition for dependencies; repeatable
  --define <name>=<value>  Replace a global expression; repeatable
`.trim();

const BACKENDS: readonly string[] = ["quickjs", "boa", "v8", "portable"];
const TIME_ZONE_DATA: readonly string[] = ["utc", "golden", "all"];
const ASYNC_CONTEXT: readonly string[] = ["serialized", "propagated"];
const VALUED = new Set([
  "--out",
  "--backend",
  "--public",
  "--require",
  "--locale",
  "--time-zones",
  "--async-context",
  "--condition",
  "--define",
]);

/** The options a `fetchlet build` command line gives, or the reason it is invalid. */
export function parseBuildArguments(
  args: readonly string[],
  cwd: string,
): BuildCommandOptions | { error: string } {
  const options: BuildCommandOptions = {
    entry: "src/server.ts",
    out: "build",
    backend: "portable",
    requirements: [],
    locales: [],
    timeZoneData: undefined,
    asyncContext: undefined,
    conditions: [],
    define: {},
    publicDir: undefined,
    assets: false,
    cwd,
  };
  let entry: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--assets") {
      options.assets = true;
      continue;
    }
    if (!option.startsWith("-")) {
      if (entry !== undefined) {
        return { error: `one entry only; got ${entry} and ${option}` };
      }
      entry = option;
      continue;
    }
    if (!VALUED.has(option)) {
      return { error: `unknown option ${option}` };
    }
    const value = args[index + 1];
    if (value === undefined) {
      return { error: `${option} needs a value` };
    }
    index++;
    if (option === "--out") {
      options.out = value;
    } else if (option === "--backend") {
      if (!BACKENDS.includes(value)) {
        return { error: `--backend needs one of ${BACKENDS.join(", ")}` };
      }
      options.backend = value as BuildBackend;
    } else if (option === "--public") {
      options.publicDir = value;
    } else if (option === "--require") {
      options.requirements.push(value);
    } else if (option === "--locale") {
      options.locales.push(value);
    } else if (option === "--time-zones") {
      if (!TIME_ZONE_DATA.includes(value)) {
        return { error: `--time-zones needs one of ${TIME_ZONE_DATA.join(", ")}` };
      }
      options.timeZoneData = value as BuildCommandOptions["timeZoneData"];
    } else if (option === "--async-context") {
      if (!ASYNC_CONTEXT.includes(value)) {
        return { error: `--async-context needs one of ${ASYNC_CONTEXT.join(", ")}` };
      }
      options.asyncContext = value as AsyncContextMode;
    } else if (option === "--condition") {
      options.conditions.push(value);
    } else {
      const equals = value.indexOf("=");
      if (equals <= 0) {
        return { error: "--define needs <name>=<value>" };
      }
      options.define[value.slice(0, equals)] = value.slice(equals + 1);
    }
  }
  if (entry !== undefined) {
    options.entry = entry;
  }
  if (options.assets && options.publicDir === undefined) {
    return { error: "--assets packs the --public directory; name one" };
  }
  return options;
}

/** Builds the artifact and returns the exit code, reporting failures. */
export async function build(options: BuildCommandOptions): Promise<number> {
  const entry = resolve(options.cwd, options.entry);
  const out = resolve(options.cwd, options.out);
  if (!existsSync(entry)) {
    console.error(`fetchlet build: ${options.entry} does not exist`);
    return 1;
  }
  const client = join(out, "client");
  // The client directory and the archive are the command's own outputs, so a
  // build replaces what an earlier one left.
  rmSync(client, { recursive: true, force: true });
  rmSync(join(out, "assets.flpk"), { force: true });
  if (options.publicDir !== undefined) {
    const publicDir = resolve(options.cwd, options.publicDir);
    if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) {
      console.error(`fetchlet build: ${options.publicDir} is not a directory`);
      return 1;
    }
    cpSync(publicDir, client, { recursive: true });
  }
  try {
    await buildArtifact({
      entry: exportedHandler(entry),
      outDir: out,
      backend: options.backend,
      requirements: options.requirements,
      intl: {
        ...(options.locales.length > 0 ? { locales: options.locales } : {}),
        ...(options.timeZoneData ? { timeZoneData: options.timeZoneData } : {}),
      },
      asyncContext: options.asyncContext,
      conditions: options.conditions,
      define: options.define,
      assets: options.assets,
    });
  } catch (error) {
    console.error(`fetchlet build: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(`fetchlet build: wrote ${options.out}`);
  return 0;
}

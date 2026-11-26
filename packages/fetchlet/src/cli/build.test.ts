import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { build, parseBuildArguments } from "./build.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

describe("parseBuildArguments", () => {
  test("defaults to src/server.ts, build and the portable backend", () => {
    expect(parseBuildArguments([], "/project")).toStrictEqual({
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
      cwd: "/project",
    });
  });

  test("reads the entry and every option", () => {
    expect(
      parseBuildArguments(
        [
          "--backend",
          "quickjs",
          "app/server.ts",
          "--out",
          "dist",
          "--public",
          "public",
          "--assets",
          "--require",
          "Intl.Segmenter",
          "--require",
          "WebAssembly",
          "--locale",
          "en",
          "--locale",
          "ja",
          "--time-zones",
          "golden",
          "--async-context",
          "propagated",
          "--condition",
          "workerd",
          "--define",
          "__VERSION__='1.0'",
          "--define",
          "DEBUG=a=b",
        ],
        "/project",
      ),
    ).toStrictEqual({
      entry: "app/server.ts",
      out: "dist",
      backend: "quickjs",
      requirements: ["Intl.Segmenter", "WebAssembly"],
      locales: ["en", "ja"],
      timeZoneData: "golden",
      asyncContext: "propagated",
      conditions: ["workerd"],
      define: { __VERSION__: "'1.0'", DEBUG: "a=b" },
      publicDir: "public",
      assets: true,
      cwd: "/project",
    });
  });

  test("refuses invalid command lines", () => {
    const error = (args: string[]) => {
      const result = parseBuildArguments(args, "/p");
      return "error" in result ? result.error : undefined;
    };
    expect(error(["--bogus"])).toBe("unknown option --bogus");
    expect(error(["--out"])).toBe("--out needs a value");
    expect(error(["a.ts", "b.ts"])).toBe("one entry only; got a.ts and b.ts");
    expect(error(["--backend", "node"])).toBe("--backend needs one of quickjs, boa, v8, portable");
    expect(error(["--time-zones", "some"])).toBe("--time-zones needs one of utc, golden, all");
    expect(error(["--async-context", "on"])).toBe(
      "--async-context needs one of serialized, propagated",
    );
    expect(error(["--define", "=x"])).toBe("--define needs <name>=<value>");
    expect(error(["--define", "x"])).toBe("--define needs <name>=<value>");
    expect(error(["--assets"])).toBe("--assets packs the --public directory; name one");
  });
});

describe("build", () => {
  function project(): string {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-cli-build-"));
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "src", "server.ts"),
      `export default { fetch: (request: Request): Response => new Response(new URL(request.url).pathname) };
       export function greet(name: string): string { return "hi " + name; }`,
    );
    mkdirSync(join(directory, "public", "styles"), { recursive: true });
    writeFileSync(join(directory, "public", "index.html"), "<!doctype html>");
    writeFileSync(join(directory, "public", "styles", "site.css"), "body {}");
    return directory;
  }

  test("builds the module, copies the static files and packs them", async () => {
    const cwd = project();
    const options = parseBuildArguments(
      ["--backend", "quickjs", "--public", "public", "--assets"],
      cwd,
    );
    if ("error" in options) {
      throw new Error(options.error);
    }
    expect(await build(options)).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, "build", "fetchlet.json"), "utf8"));
    expect(manifest).toMatchObject({ handler: "handle", functions: ["greet"], backend: "quickjs" });
    expect(existsSync(join(cwd, "build", "server.js"))).toBe(true);
    expect(readFileSync(join(cwd, "build", "client", "styles", "site.css"), "utf8")).toBe(
      "body {}",
    );
    expect(existsSync(join(cwd, "build", "assets.flpk"))).toBe(true);
  });

  test("a later build without static files leaves none of the earlier ones", async () => {
    const cwd = project();
    const withAssets = parseBuildArguments(["--public", "public", "--assets"], cwd);
    const without = parseBuildArguments([], cwd);
    if ("error" in withAssets || "error" in without) {
      throw new Error("invalid options");
    }
    expect(await build(withAssets)).toBe(0);
    expect(await build(without)).toBe(0);
    expect(existsSync(join(cwd, "build", "client"))).toBe(false);
    expect(existsSync(join(cwd, "build", "assets.flpk"))).toBe(false);
    expect(existsSync(join(cwd, "build", "server.js"))).toBe(true);
  });

  test("fails without the entry or the static directory", async () => {
    const cwd = project();
    const missingEntry = parseBuildArguments(["src/missing.ts"], cwd);
    const missingPublic = parseBuildArguments(["--public", "static"], cwd);
    if ("error" in missingEntry || "error" in missingPublic) {
      throw new Error("invalid options");
    }
    expect(await build(missingEntry)).toBe(1);
    expect(await build(missingPublic)).toBe(1);
    expect(existsSync(join(cwd, "build", "server.js"))).toBe(false);
  });

  test("reports a module that exports the reserved handler name", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "server.ts"), "export const handle = 1;");
    const options = parseBuildArguments([], cwd);
    if ("error" in options) {
      throw new Error(options.error);
    }
    expect(await build(options)).toBe(1);
  });
});

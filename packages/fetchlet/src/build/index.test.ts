import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Plugin } from "rolldown";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { buildArtifact, type BuildArtifactOptions } from "./index.ts";
import { nativeCapabilityCheck } from "./polyfills/bootstrap.ts";
import { planPolyfills } from "./polyfills/plan.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

function files(paths: Record<string, string>): string {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-build-"));
  for (const [path, text] of Object.entries(paths)) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return directory;
}

/** Build `source` as the entry, and return the bundle and its manifest. */
async function build(
  source: string,
  options: Partial<BuildArtifactOptions> = {},
  paths: Record<string, string> = {},
) {
  const root = files(paths);
  const outDir = join(root, "out");
  await buildArtifact({
    entry: {
      source,
      resolveDir: root,
    },
    outDir,
    ...options,
  });
  return {
    root,
    outDir,
    server: readFileSync(join(outDir, "server.js"), "utf8"),
    manifest: JSON.parse(readFileSync(join(outDir, "fetchlet.json"), "utf8")),
  };
}

describe("buildArtifact", () => {
  test("writes the manifest of a portable artifact", async () => {
    const { manifest } = await build("export const handle = () => 1;", {
      framework: "test",
      rendering: "buffered",
    });
    expect(manifest).toStrictEqual({
      format: "fetchlet-iife",
      formatVersion: 1,
      handler: "handle",
      functions: [],
      server: "server.js",
      client: "client",
      profile: "portable-web",
      framework: "test",
      rendering: "buffered",
      requirements: [],
      backend: "portable",
      nativeRequirements: [],
      polyfills: [],
      intl: {
        locales: ["en"],
        timeZoneData: "utc",
      },
    });
  });

  test("records the polyfill plan for the backend", async () => {
    const { manifest, server } = await build("export const handle = () => 1;", {
      backend: "v8",
      requirements: ["Intl.DateTimeFormat"],
      asyncContext: "serialized",
    });
    expect(manifest).toMatchObject({
      backend: "v8",
      asyncContext: "serialized",
      requirements: ["Intl.DateTimeFormat"],
      nativeRequirements: ["Intl.DateTimeFormat"],
      polyfills: [],
    });
    expect(server).toMatch(/var requirements = \["Intl\.DateTimeFormat"\];/);
  });

  test("bundles one IIFE that assigns the entry's exports", async () => {
    const { server } = await build(
      `import { message } from "./app.js";
       export const handle = () => message;
       export function greet() { return "hi"; }`,
      {},
      {
        "app.js": 'export const message = "from the app";',
      },
    );
    expect(server).toMatch(/var fetchletExports = \(function/);
    expect(server).toContain("from the app");
    expect(server).not.toMatch(/^\s*(import|export)\s/m);
  });

  test("Node built-ins are fetchlet's or stubs, but npm packages of the same name win", async () => {
    const { server } = await build(
      `import fs from "node:fs";
       import { createHash } from "node:crypto";
       import { marker } from "punycode";
       export const handle = () => [typeof fs.readFileSync, createHash, marker];`,
      {},
      {
        "node_modules/punycode/package.json": JSON.stringify({
          name: "punycode",
          type: "module",
          main: "index.js",
        }),
        "node_modules/punycode/index.js": 'export const marker = "npm punycode";',
      },
    );
    expect(server).toContain("is not available in fetchlet");
    expect(server).toContain("nodeCrypto.hash");
    expect(server).toContain("npm punycode");
    expect(server).not.toMatch(/require\(["']node:fs["']\)/);
  });

  test("defines NODE_ENV as production, with the adapter's own replacements", async () => {
    const { server } = await build(
      `export const handle = () => [process.env.NODE_ENV, __FLAG__];`,
      {
        define: {
          __FLAG__: JSON.stringify("flag value"),
        },
      },
    );
    expect(server).toContain('"production"');
    expect(server).toContain('"flag value"');
    expect(server).not.toContain("process.env.NODE_ENV");
  });

  test("serialized async context replaces node:async_hooks with fetchlet's", async () => {
    const source = `import { AsyncLocalStorage } from "node:async_hooks";
      export const handle = () => new AsyncLocalStorage();`;
    const { server } = await build(source, {
      asyncContext: "serialized",
    });
    expect(server).toContain("enterWith");
    const { server: empty } = await build(source);
    expect(empty).not.toContain("enterWith");
  });

  test("propagated async context builds AsyncLocalStorage over the engine slot", async () => {
    const { server, manifest } = await build(
      `import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
      export const handle = () => [new AsyncLocalStorage(), AsyncResource];`,
      {
        asyncContext: "propagated",
      },
    );
    expect(server).toContain("__fetchletAsyncContext");
    expect(server).toContain("runInAsyncScope");
    expect(manifest).toMatchObject({
      asyncContext: "propagated",
    });
  });

  test("the adapter's plugins run after fetchlet's own and before the Node built-ins", async () => {
    const seen: string[] = [];
    const plugin: Plugin = {
      name: "adapter",
      resolveId(id) {
        seen.push(id);
        if (id === "node:path") {
          return "\0adapter:path";
        }
      },
      load(id) {
        if (id === "\0adapter:path") {
          return 'export const sep = "adapter path";';
        }
      },
    };
    const { server } = await build(
      `import { sep } from "node:path";
       export const handle = () => sep;`,
      {
        plugins: [plugin],
      },
    );
    expect(server).toContain("adapter path");
    expect(seen).toContain("node:path");
  });

  test("assets archive the client directory after the build", async () => {
    const { outDir } = await build(
      "export const handle = () => 1;",
      {
        assets: true,
      },
      {
        "out/client/index.html": "<p>hi</p>",
      },
    );
    expect(existsSync(join(outDir, "assets.flpk"))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, "fetchlet.json"), "utf8")).assets).toBe(
      "assets.flpk",
    );
  });

  test("invalid options fail before anything is written", async () => {
    const root = files({});
    await expect(
      buildArtifact({
        entry: {
          source: "export const handle = () => 1;",
          resolveDir: root,
        },
        outDir: join(root, "out"),
        requirements: ["Intl.Segmenter"],
      }),
    ).rejects.toThrow(/Unsupported fetchlet Intl API/);
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});

describe("nativeCapabilityCheck", () => {
  const check = (backend: "v8" | "portable", locales: string[], intl: object) => () =>
    // The generated check is source text that the engine evaluates.
    // eslint-disable-next-line typescript/no-implied-eval
    new Function(
      "globalThis",
      nativeCapabilityCheck(
        planPolyfills({
          backend,
          requirements: ["Intl.DateTimeFormat"],
          intl: {
            locales,
          },
        }),
      ),
    )({ Intl: intl });

  test("passes when the engine provides the API and every locale", () => {
    expect(check("v8", ["en", "ja"], Intl)).not.toThrow();
  });

  test("fails when the engine lacks a native requirement", () => {
    expect(check("v8", ["en"], {})).toThrow(
      "fetchlet artifact requires native Intl.DateTimeFormat; rebuild for this backend",
    );
  });

  test("fails when the engine lacks a locale", () => {
    const DateTimeFormat = Object.assign(function () {}, {
      supportedLocalesOf: (locales: string[]) => locales.filter((locale) => locale === "en"),
    });
    expect(check("v8", ["en", "ja"], { DateTimeFormat })).toThrow(
      "fetchlet artifact requires Intl.DateTimeFormat locales: en, ja",
    );
  });

  test("checks nothing for APIs the artifact polyfills", () => {
    expect(check("portable", ["en"], {})).not.toThrow();
  });
});

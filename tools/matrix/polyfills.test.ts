// Builds Intl artifacts for each backend with fetchlet/build and checks the
// selected polyfills and their locale data, and measures which polyfillable
// and engine-only APIs each engine provides natively.
// Records results/polyfill-matrix.json: `vp run test:polyfills`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { backends, runLab, type Backend, type Reply } from "@fetchlet-internal/tools-workspace/lab";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import {
  describe,
  environment,
  summarize,
  writeResult,
} from "@fetchlet-internal/tools-workspace/results";
import { engineOnlyApis, polyfills as polyfillCatalog } from "@fetchlet/web/gaps";
import { buildArtifact, type BuildArtifactOptions } from "fetchlet/build";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

// The planner is internal to fetchlet/build; this suite checks it directly.
import {
  planPolyfills,
  type PlanOptions,
} from "../../packages/fetchlet/src/build/polyfills/plan.ts";

type Plugin = NonNullable<BuildArtifactOptions["plugins"]>[number];

interface Artifact {
  server: string;
  bytes: number;
  manifest: { polyfills: { api: string }[] };
  modules: string[];
}

const output = resolve(root, ".cache/polyfills");
const entry = resolve(root, "fixtures/intl.ts");
const artifacts = new Map<string, Artifact>();
const results: { name: string; status: "pass" | "fail"; error?: string }[] = [];
const nativeCapabilities: Record<string, Record<string, boolean>> = {};
mkdirSync(output, { recursive: true });

function check(name: string, operation: () => void | Promise<void>): void {
  test(name, { timeout: 120_000 }, async () => {
    try {
      await operation();
      results.push({ name, status: "pass" });
    } catch (error) {
      results.push({ name, status: "fail", error: describe(error) });
      throw error;
    }
  });
}

function execute(backend: Backend, bundle: string, exportName: string): Reply {
  const session = runLab([backend, bundle], [{ export: exportName, args: [] }], {
    timeoutMs: 90_000,
  });
  expect(session.status, session.stderr).toBe(0);
  const [reply] = session.replies;
  if (!reply) {
    expect.fail(session.stdout + session.stderr);
  }
  return reply;
}

function artifactNamed(name: string): Artifact {
  const artifact = artifacts.get(name);
  if (!artifact) {
    expect.fail(`artifact ${name} was not built`);
  }
  return artifact;
}

async function buildIntlArtifact(
  name: string,
  options: Omit<BuildArtifactOptions, "entry" | "outDir">,
): Promise<void> {
  const modules = new Set<string>();
  const outDir = resolve(output, name);
  const recordModules: Plugin = {
    name: "record-polyfill-modules",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") {
          continue;
        }
        for (const module of Object.keys(chunk.modules)) {
          if (module.includes("@formatjs")) {
            modules.add(module.replaceAll("\\", "/"));
          }
        }
      }
    },
  };
  await buildArtifact({ entry, outDir, ...options, plugins: [recordModules] });
  const server = resolve(outDir, "server.js");
  artifacts.set(name, {
    server,
    bytes: readFileSync(server).length,
    manifest: JSON.parse(readFileSync(resolve(outDir, "fetchlet.json"), "utf8")),
    modules: [...modules],
  });
}

beforeAll(async () => {
  const requirements = [
    "Intl.DateTimeFormat",
    "Intl.NumberFormat",
    "Intl.PluralRules",
    "Intl.Locale",
    "Intl.ListFormat",
    "Intl.DisplayNames",
    "Intl.RelativeTimeFormat",
    "Intl.Segmenter",
    "Intl.DurationFormat",
  ];
  const intl = {
    locales: ["en", "ja"],
    timeZoneData: "golden",
  } as const satisfies PlanOptions["intl"];
  await buildIntlArtifact("quickjs", {
    backend: "quickjs",
    requirements,
    intl,
  });
  await buildIntlArtifact("v8", { backend: "v8", requirements, intl });
  await buildIntlArtifact("plain", { backend: "quickjs" });
  await buildIntlArtifact("plural", {
    backend: "boa",
    requirements: ["Intl.PluralRules"],
    intl: { locales: ["ja"] },
  });
});

afterAll(() => {
  writeResult("polyfill-matrix.json", {
    environment: environment(),
    summary: summarize(results),
    nativeCapabilities,
    artifacts: Object.fromEntries(
      [...artifacts].map(([name, artifact]) => [
        name,
        {
          bytes: artifact.bytes,
          polyfills: artifact.manifest.polyfills,
          formatjsModules: artifact.modules,
        },
      ]),
    ),
    results,
  });
});

// Records each engine's native APIs, from which `vp run
// build:engine-capabilities` writes the table the planner uses.
check("each engine's native APIs are measured", () => {
  const file = resolve(output, "native.js");
  writeFileSync(
    file,
    `var fetchletExports = {
    capabilities() {
      return Object.fromEntries(
        ${JSON.stringify([...Object.keys(polyfillCatalog), ...engineOnlyApis])}.map((api) => {
          let value = globalThis;
          for (const key of api.split(".")) {
            value = value === undefined || value === null ? undefined : value[key];
          }
          return [api, value !== undefined && value !== null];
        }),
      );
    }
  };`,
  );
  for (const backend of backends) {
    const reply = execute(backend, file, "capabilities");
    if (!reply.ok) {
      expect.fail(reply.error);
    }
    nativeCapabilities[backend] = reply.value as Record<string, boolean>;
  }
});

for (const backend of backends) {
  check(backend + " executes selected Intl APIs with Japanese and Tokyo data", () => {
    const artifact = artifactNamed(backend === "v8" ? "v8" : "quickjs");
    const reply = execute(backend, artifact.server, "format");
    if (!reply.ok) {
      expect.fail(reply.error);
    }
    const { frenchSupported, usesFormatJS, ...formatted } = reply.value;
    expect(formatted).toStrictEqual({
      canonical: ["en-US"],
      locale: "ja",
      plural: ["one", "other"],
      number: "￥1,234",
      utc: "01/02/2024",
      tokyo: "09:00",
    });
    expect(usesFormatJS).toBe(backend !== "v8");
    expect(frenchSupported).toBe(backend === "v8");
  });
}

for (const backend of backends) {
  check(backend + " executes list, display name, relative time, segment and duration APIs", () => {
    const artifact = artifactNamed(backend === "v8" ? "v8" : "quickjs");
    const reply = execute(backend, artifact.server, "formatText");
    if (!reply.ok) {
      expect.fail(reply.error);
    }
    expect(reply.value).toStrictEqual({
      list: "a, b, and c",
      listJa: "a\u3001b\u3001c",
      region: "Japan",
      languageJa: "\u82f1\u8a9e",
      yesterday: "yesterday",
      inHoursJa: "3 \u6642\u9593\u5f8c",
      words: ["Hello", "world"],
      graphemes: 2,
      duration: "1 hour, 30 minutes",
      digital: "1:05:03",
    });
  });
}

check("V8 and unrequested Intl contribute zero FormatJS modules", () => {
  for (const name of ["v8", "plain"]) {
    expect(artifactNamed(name).manifest.polyfills).toStrictEqual([]);
    expect(artifactNamed(name).modules).toStrictEqual([]);
  }
  expect(artifactNamed("quickjs").bytes > artifactNamed("v8").bytes).toBeTruthy();
});

check("plural-only artifacts contain their dependencies and selected locale", () => {
  const { manifest, modules } = artifactNamed("plural");
  expect(manifest.polyfills.map((polyfill) => polyfill.api)).toStrictEqual([
    "Intl.getCanonicalLocales",
    "Intl.Locale",
    "Intl.PluralRules",
  ]);
  expect(
    modules.some((module) => module.includes("/intl-pluralrules/locale-data/ja.js")),
  ).toBeTruthy();
  expect(modules.every((module) => !module.includes("/intl-numberformat/"))).toBeTruthy();
  expect(modules.every((module) => !module.includes("/intl-datetimeformat/"))).toBeTruthy();
  expect(modules.every((module) => !module.includes("/locale-data/en.js"))).toBeTruthy();
});

check("native requirements fail clearly on an incompatible runtime", () => {
  const session = runLab(["quickjs", artifactNamed("v8").server], [], {
    timeoutMs: 30_000,
  });
  expect(session.status).not.toBe(0);
  expect(session.stderr.includes("requires native Intl."), session.stderr).toBeTruthy();
});

check("invalid APIs, backend names and locale data fail at build planning", () => {
  // Options from JavaScript callers, which the declared types would reject.
  const plan = (options: unknown) => () => planPolyfills(options as PlanOptions);
  expect(plan({ requirements: "Intl.Locale" })).toThrow(/array of API names/);
  expect(plan({ intl: { apis: "Intl.Locale" } })).toThrow(/array of API names/);
  expect(plan({ backend: "unknown" })).toThrow(/Unknown fetchlet backend/);
  expect(plan({ requirements: ["Intl.Unknown"] })).toThrow(/Unsupported fetchlet Intl API/);
  expect(plan({ intl: { locales: [] } })).toThrow(/at least one locale/);
  expect(plan({ intl: { timeZoneData: "unknown" } })).toThrow(/timeZoneData/);
  expect(
    plan({
      requirements: ["Intl.DateTimeFormat"],
      intl: { locales: ["zz"] },
    }),
  ).toThrow(/locale data is unavailable/);
});

// Builds Intl artifacts for each backend with @fetchlet/build and checks the
// selected polyfills, their locale data and the native capability catalog.
// Records results/polyfill-matrix.json: `vp run test:polyfills`.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { buildArtifact, type BuildArtifactOptions } from "@fetchlet/build";
// The planner is internal to @fetchlet/build; this suite checks it directly.
import { planPolyfills, type PlanOptions } from "../../packages/build/src/polyfills/plan.mjs";
import { backends, runLab, type Backend, type Reply } from "@fetchlet-internal/tools-workspace/lab";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { describe, summarize, writeResult } from "@fetchlet-internal/tools-workspace/results";
import type { Plugin } from "vite-plus";

interface Artifact {
  server: string;
  bytes: number;
  manifest: { polyfills: { api: string }[] };
  modules: string[];
}

const output = resolve(root, ".cache/polyfills");
const entry = resolve(root, "packages/build/tests/fixtures/intl.mjs");
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
  assert.equal(session.status, 0, session.stderr);
  const [reply] = session.replies;
  assert.ok(reply, session.stdout + session.stderr);
  return reply;
}

function artifactNamed(name: string): Artifact {
  const artifact = artifacts.get(name);
  assert.ok(artifact, `artifact ${name} was not built`);
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
        if (chunk.type !== "chunk") continue;
        for (const module of Object.keys(chunk.modules)) {
          if (module.includes("@formatjs")) modules.add(module.replaceAll("\\", "/"));
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

before(async () => {
  const requirements = [
    "Intl.DateTimeFormat",
    "Intl.NumberFormat",
    "Intl.PluralRules",
    "Intl.Locale",
  ];
  const intl = {
    locales: ["en", "ja"],
    timeZoneData: "golden",
  } as const satisfies PlanOptions["intl"];
  await buildIntlArtifact("quickjs", { backend: "quickjs", requirements, intl });
  await buildIntlArtifact("v8", { backend: "v8", requirements, intl });
  await buildIntlArtifact("plain", { backend: "quickjs" });
  await buildIntlArtifact("plural", {
    backend: "boa",
    requirements: ["Intl.PluralRules"],
    intl: { locales: ["ja"] },
  });
});

after(() => {
  writeResult("polyfill-matrix.json", {
    checkedAt: new Date().toISOString(),
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

check("default backend Intl capabilities match the build catalog", () => {
  const file = resolve(output, "native.js");
  writeFileSync(
    file,
    `var fetchletExports = {
    capabilities() {
      return Object.fromEntries(
        ["getCanonicalLocales", "Locale", "PluralRules", "NumberFormat", "DateTimeFormat"]
          .map(name => ["Intl." + name, typeof globalThis.Intl?.[name] === "function"]),
      );
    }
  };`,
  );
  for (const backend of backends) {
    const reply = execute(backend, file, "capabilities");
    assert.ok(reply.ok);
    const capabilities = reply.value as Record<string, boolean>;
    nativeCapabilities[backend] = capabilities;
    const plan = planPolyfills({ backend, requirements: Object.keys(capabilities) });
    assert.deepEqual(
      new Set(plan.nativeRequirements),
      new Set(
        Object.entries(capabilities)
          .filter(([, native]) => native)
          .map(([api]) => api),
      ),
    );
  }
});

for (const backend of backends) {
  check(backend + " executes selected Intl APIs with Japanese and Tokyo data", () => {
    const artifact = artifactNamed(backend === "v8" ? "v8" : "quickjs");
    const reply = execute(backend, artifact.server, "format");
    if (!reply.ok) assert.fail(reply.error);
    const { frenchSupported, usesFormatJS, ...formatted } = reply.value;
    assert.deepEqual(formatted, {
      canonical: ["en-US"],
      locale: "ja",
      plural: ["one", "other"],
      number: "￥1,234",
      utc: "01/02/2024",
      tokyo: "09:00",
    });
    assert.equal(usesFormatJS, backend !== "v8");
    assert.equal(frenchSupported, backend === "v8");
  });
}

check("V8 and unrequested Intl contribute zero FormatJS modules", () => {
  for (const name of ["v8", "plain"]) {
    assert.deepEqual(artifactNamed(name).manifest.polyfills, []);
    assert.deepEqual(artifactNamed(name).modules, []);
  }
  assert.ok(artifactNamed("quickjs").bytes > artifactNamed("v8").bytes);
});

check("plural-only artifacts contain their dependencies and selected locale", () => {
  const { manifest, modules } = artifactNamed("plural");
  assert.deepEqual(
    manifest.polyfills.map((polyfill) => polyfill.api),
    ["Intl.getCanonicalLocales", "Intl.Locale", "Intl.PluralRules"],
  );
  assert.ok(modules.some((module) => module.includes("/intl-pluralrules/locale-data/ja.js")));
  assert.ok(modules.every((module) => !module.includes("/intl-numberformat/")));
  assert.ok(modules.every((module) => !module.includes("/intl-datetimeformat/")));
  assert.ok(modules.every((module) => !module.includes("/locale-data/en.js")));
});

check("native requirements fail clearly on an incompatible runtime", () => {
  const session = runLab(["quickjs", artifactNamed("v8").server], [], { timeoutMs: 30_000 });
  assert.notEqual(session.status, 0);
  assert.ok(session.stderr.includes("requires native Intl."), session.stderr);
});

check("invalid APIs, backend names and locale data fail at build planning", () => {
  // Options from JavaScript callers, which the declared types would reject.
  const plan = (options: unknown) => () => planPolyfills(options as PlanOptions);
  assert.throws(plan({ requirements: "Intl.Locale" }), /array of API names/);
  assert.throws(plan({ intl: { apis: "Intl.Locale" } }), /array of API names/);
  assert.throws(plan({ backend: "unknown" }), /Unknown fetchlet backend/);
  assert.throws(plan({ requirements: ["Intl.Unknown"] }), /Unsupported fetchlet Intl API/);
  assert.throws(plan({ intl: { locales: [] } }), /at least one locale/);
  assert.throws(plan({ intl: { timeZoneData: "unknown" } }), /timeZoneData/);
  assert.throws(
    plan({ requirements: ["Intl.DateTimeFormat"], intl: { locales: ["zz"] } }),
    /locale data is unavailable/,
  );
});
